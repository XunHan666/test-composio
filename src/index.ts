import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import type { Client } from "@notionhq/client"
import crypto from "node:crypto"

const worker = new Worker()
export default worker

// ─────────────────────────────────────────────
// THIẾT KẾ WORKER — 4 câu hỏi cốt lõi (Nguyên tắc 1.1)
// ─────────────────────────────────────────────
// Trigger     : Webhook "investigateCompetitors" — nút bấm trên Bảng 3 (Yêu cầu báo cáo)
//               Tool "scanChannelNow" — gọi qua chat Custom Agent
// Input       : page_id dòng Yêu cầu (webhook) | url + subjectName + ... (tool)
// Output      : Dòng sự kiện vào Bảng 2 + Google Doc tóm tắt (webhook) | dòng đơn lẻ (tool)
// Batch size  : Tối đa 50 nguồn Watchlist × 10 video/kênh; 5 mentions/đối thủ
// Idempotency : eventId = SHA-256 hash nguồn; kiểm tra Event ID trước khi ghi, retry không tạo dữ liệu trùng
// Hỏng giữa chừng: Sự kiện đã ghi giữ nguyên; retry sẽ skip qua kiểm tra eventId

// ─────────────────────────────────────────────
// ENV VARS
// ─────────────────────────────────────────────
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? ""
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ""
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ?? ""

// ─────────────────────────────────────────────
// PACERS
// ─────────────────────────────────────────────
const youtubePacer = worker.pacer("youtube", { allowedRequests: 5, intervalMs: 1000 })
const geminiPacer = worker.pacer("gemini", { allowedRequests: 5, intervalMs: 1000 })
const mentionsPacer = worker.pacer("mentions", { allowedRequests: 2, intervalMs: 2000 })

// ─────────────────────────────────────────────
// INTERNAL TYPES
// ─────────────────────────────────────────────

interface WatchlistEntry {
	pageId: string
	id: string
	name: string
	type: "YouTube" | "Website"
	link: string
	threatenedProduct: string
	solutionArea: string
}

interface GeminiAnalysis {
	classification: string
	urgency: "Cao" | "Theo dõi thêm"
	impact: string
	evidence: string
}

/** Intermediate type — all scalar values, used for both webhook and tool */
interface ProcessedItem {
	eventId: string
	shortTitle: string
	subjectName: string
	platform: "YouTube" | "Website" | "Bên thứ 3"
	classification: string
	urgency: "Cao" | "Theo dõi thêm"
	impact: string
	threatenedProduct: string
	solutionArea: string
	transcriptSource: "Có" | "Không" | "Chỉ title-description"
	link: string
	publishedAt: string
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function hashString(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16)
}

/** Lấy transcript công khai YouTube (không dùng captions.download — chỉ hoạt động với kênh sở hữu) */
async function fetchYouTubeTranscript(videoId: string): Promise<string | null> {
	for (const lang of ["vi", "en"]) {
		try {
			const url = `https://video.google.com/timedtext?lang=${lang}&v=${videoId}&fmt=srv3`
			const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
			if (!res.ok) continue
			const text = await res.text()
			if (!text || text.length < 100) continue
			const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
			if (plain.length > 50) return plain
		} catch {
			// thử ngôn ngữ tiếp theo
		}
	}
	return null
}

/** Gọi Gemini phân tích nội dung, trả về classification + urgency + impact + evidence */
async function analyzeWithGemini(
	title: string,
	bodyText: string,
	transcript: string | null,
	subjectName: string,
): Promise<GeminiAnalysis> {
	const contentSection = transcript
		? `Transcript:\n${transcript.slice(0, 4000)}`
		: `Nội dung/Mô tả:\n${bodyText.slice(0, 2000)}`

	const prompt = `Bạn là chuyên gia phân tích cạnh tranh. Phân tích nội dung sau của đối thủ "${subjectName}" và trả về JSON hợp lệ (chỉ JSON thuần, không giải thích):

Tiêu đề: ${title}
${contentSection}

Trả về JSON:
{
  "classification": "Sponsored Video" | "Review" | "New Feature" | "Pricing Change",
  "urgency": "Cao" | "Theo dõi thêm",
  "impact": "Nhận định tác động 1-2 câu tiếng Việt",
  "evidence": "Trích dẫn bằng chứng cụ thể từ nội dung"
}

Urgency "Cao" nếu ảnh hưởng trực tiếp thị phần, đối đầu sản phẩm, thay đổi giá.`

	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
				}),
				signal: AbortSignal.timeout(30000),
			},
		)
		if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`)

		const data = (await res.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
		}
		const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
		const jsonMatch = rawText.match(/\{[\s\S]*\}/)
		if (!jsonMatch) throw new Error("No JSON found in response")

		const parsed = JSON.parse(jsonMatch[0]) as Partial<GeminiAnalysis>
		return {
			classification: parsed.classification ?? "Review",
			urgency: parsed.urgency === "Cao" ? "Cao" : "Theo dõi thêm",
			impact: parsed.impact ?? "",
			evidence: parsed.evidence ?? title,
		}
	} catch (err) {
		console.error("Gemini error:", err)
		return {
			classification: "Review",
			urgency: "Theo dõi thêm",
			impact: "Không thể phân tích tự động.",
			evidence: title,
		}
	}
}

/** Lấy danh sách video mới đăng của kênh YouTube theo khoảng thời gian */
async function fetchRecentYouTubeVideos(
	channelLink: string,
	startDate: string,
	endDate: string,
): Promise<Array<{ videoId: string; title: string; description: string; publishedAt: string }>> {
	const channelIdMatch = channelLink.match(/channel\/(UC[\w-]+)/)
	const channelId = channelIdMatch?.[1] ?? null

	if (channelId) {
		await youtubePacer.wait()
		const chRes = await fetch(
			`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`,
			{ signal: AbortSignal.timeout(10000) },
		)
		const chData = (await chRes.json()) as {
			items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>
		}
		const uploadsId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads

		if (uploadsId) {
			await youtubePacer.wait()
			const plRes = await fetch(
				`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=10&key=${YOUTUBE_API_KEY}`,
				{ signal: AbortSignal.timeout(10000) },
			)
			const plData = (await plRes.json()) as {
				items?: Array<{
					snippet?: {
						resourceId?: { videoId?: string }
						title?: string
						description?: string
						publishedAt?: string
					}
				}>
			}
			const startD = new Date(startDate)
			const endD = new Date(endDate)
			return (plData.items ?? [])
				.filter((item) => {
					const pub = item.snippet?.publishedAt
					if (!pub || !item.snippet?.resourceId?.videoId) return false
					const d = new Date(pub)
					return d >= startD && d <= endD
				})
				.map((item) => ({
					videoId: item.snippet!.resourceId!.videoId!,
					title: item.snippet?.title ?? "",
					description: item.snippet?.description ?? "",
					publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
				}))
		}
	}

	// Fallback: search API
	await youtubePacer.wait()
	const searchRes = await fetch(
		`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video${channelId ? `&channelId=${channelId}` : ""}&publishedAfter=${startDate}&publishedBefore=${endDate}&maxResults=20&order=date&key=${YOUTUBE_API_KEY}`,
		{ signal: AbortSignal.timeout(10000) },
	)
	const searchData = (await searchRes.json()) as {
		items?: Array<{
			id?: { videoId?: string }
			snippet?: { title?: string; description?: string; publishedAt?: string }
		}>
	}
	return (searchData.items ?? [])
		.filter((item) => item.id?.videoId && item.snippet?.title)
		.map((item) => ({
			videoId: item.id!.videoId!,
			title: item.snippet!.title!,
			description: item.snippet?.description ?? "",
			publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
		}))
}

/** Fetch nội dung website dưới dạng plain text */
async function fetchWebsiteContent(url: string): Promise<string> {
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; NotionWorker/1.0)" },
			signal: AbortSignal.timeout(12000),
		})
		if (!res.ok) return ""
		const html = await res.text()
		return html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 5000)
	} catch {
		return ""
	}
}

/** Quét 1 kênh YouTube, trả về ProcessedItems */
async function scanYouTubeChannel(
	entry: WatchlistEntry,
	startDate: string,
	endDate: string,
): Promise<ProcessedItem[]> {
	const items: ProcessedItem[] = []
	let videos: Array<{ videoId: string; title: string; description: string; publishedAt: string }> = []

	try {
		videos = await fetchRecentYouTubeVideos(entry.link, startDate, endDate)
	} catch (err) {
		console.error(`Lỗi lấy video YouTube [${entry.name}]:`, err)
		return items
	}

	for (const video of videos.slice(0, 10)) {
		const transcript = await fetchYouTubeTranscript(video.videoId)
		await geminiPacer.wait()
		const analysis = await analyzeWithGemini(video.title, video.description, transcript, entry.name)

		items.push({
			eventId: hashString(`yt-${video.videoId}`),
			shortTitle: video.title.split(/\s+/).slice(0, 14).join(" "),
			subjectName: entry.name,
			platform: "YouTube",
			classification: analysis.classification,
			urgency: analysis.urgency,
			impact: analysis.impact,
			threatenedProduct: entry.threatenedProduct,
			solutionArea: entry.solutionArea,
			transcriptSource: transcript ? "Có" : "Chỉ title-description",
			link: `https://www.youtube.com/watch?v=${video.videoId}`,
			publishedAt: video.publishedAt,
		})
	}

	return items
}

/** Quét 1 website — mỗi lần điều tra là fetch + phân tích thẳng, không cần snapshot */
async function scanWebsite(
	entry: WatchlistEntry,
	startDate: string,
	endDate: string,
): Promise<ProcessedItem[]> {
	const content = await fetchWebsiteContent(entry.link)
	if (!content) return []

	await geminiPacer.wait()
	const analysis = await analyzeWithGemini(
		`Nội dung website: ${entry.name}`,
		content,
		null,
		entry.name,
	)

	const now = new Date().toISOString()
	return [
		{
			eventId: hashString(`web-${entry.link}-${now.slice(0, 10)}`),
			shortTitle: `Phân tích website ${entry.name}`,
			subjectName: entry.name,
			platform: "Website",
			classification: analysis.classification,
			urgency: analysis.urgency,
			impact: analysis.impact,
			threatenedProduct: entry.threatenedProduct,
			solutionArea: entry.solutionArea,
			transcriptSource: "Không",
			link: entry.link,
			publishedAt: now,
		},
	]
}

async function searchThirdPartyMentions(
	subjectName: string,
	startDate: string,
	endDate: string,
): Promise<Array<{ url: string; title: string; snippet: string }>> {
	await mentionsPacer.wait()
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{
						parts: [{
							text: `Tìm các bài báo, bài blog, bài review đăng từ ngày ${startDate.split('T')[0]} đến ngày ${endDate.split('T')[0]} nhắc đến "${subjectName}" liên quan đến sản phẩm, giá cả, tính năng mới, hoặc tin tức kinh doanh. Liệt kê ngắn gọn từng bài tìm được.`,
						}],
					}],
					tools: [{ google_search: {} }],
					generationConfig: { temperature: 0.2 },
				}),
				signal: AbortSignal.timeout(30000),
			},
		)
		if (!res.ok) throw new Error(`Gemini grounding HTTP ${res.status}`)

		const data = (await res.json()) as {
			candidates?: Array<{
				groundingMetadata?: {
					groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
				}
			}>
		}

		// QUAN TRỌNG: chỉ lấy link thật từ groundingChunks (do Google Search trả về),
		// KHÔNG lấy link tự do Gemini viết trong phần text — tránh bịa URL.
		const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
		const seen = new Set<string>()
		const results: Array<{ url: string; title: string; snippet: string }> = []

		for (const chunk of chunks) {
			const uri = chunk.web?.uri
			if (!uri || seen.has(uri)) continue
			seen.add(uri)
			results.push({
				url: uri,
				title: chunk.web?.title ?? uri,
				snippet: chunk.web?.title ?? "",
			})
		}
		return results
	} catch (err) {
		console.error(`Lỗi tìm mentions cho ${subjectName}:`, err)
		return []
	}
}

async function scanThirdPartyMentions(
	subjectName: string,
	startDate: string,
	endDate: string,
	threatenedProduct: string,
	solutionArea: string,
): Promise<ProcessedItem[]> {
	const mentions = await searchThirdPartyMentions(subjectName, startDate, endDate)
	const items: ProcessedItem[] = []

	for (const mention of mentions.slice(0, 5)) {
		await geminiPacer.wait()
		const analysis = await analyzeWithGemini(mention.title, mention.snippet, null, subjectName)
		items.push({
			eventId: hashString(`mention-${mention.url}`),
			shortTitle: mention.title.split(/\s+/).slice(0, 14).join(" "),
			subjectName,
			platform: "Bên thứ 3",
			classification: analysis.classification,
			urgency: analysis.urgency,
			impact: analysis.impact,
			threatenedProduct,
			solutionArea,
			transcriptSource: "Không",
			link: mention.url,
			publishedAt: new Date().toISOString(),
		})
	}
	return items
}

// ─────────────────────────────────────────────
// SHARED: Ghi ProcessedItem vào Bảng 2
// ─────────────────────────────────────────────

async function writeItemsToNotionDb(
	items: ProcessedItem[],
	dbId: string,
	notion: Client,
	existingIds: Set<string> = new Set(),
): Promise<number> {
	let created = 0
	for (const item of items) {
		// Idempotency: bỏ qua nếu Event ID đã tồn tại (Nguyên tắc 1.2)
		if (existingIds.has(item.eventId)) {
			console.log(`Bỏ qua trùng eventId: ${item.eventId}`)
			continue
		}
		try {
			await notion.pages.create({
				parent: { database_id: dbId },
				properties: {
					"Tiêu đề": { title: [{ text: { content: item.shortTitle.slice(0, 200) } }] },
					"Event ID": { rich_text: [{ text: { content: item.eventId } }] },
					"Chủ thể": { select: { name: item.subjectName } },
					"Nền tảng": { select: { name: item.platform } },
					"Phân loại": { select: { name: item.classification } },
					"Mức độ khẩn cấp": { select: { name: item.urgency } },
					"Sản phẩm bị đe dọa": { select: { name: item.threatenedProduct } },
					"Mảng giải pháp": { select: { name: item.solutionArea } },
					"Trạng thái xử lý": { select: { name: "Mới" } },
					"Nguồn transcript": { select: { name: item.transcriptSource } },
					"Tác động dự kiến": { rich_text: [{ text: { content: item.impact.slice(0, 2000) } }] },
					"Bằng chứng & Link": { url: item.link },
					"Ngày phát hiện": { date: { start: item.publishedAt } },
				},
			})
			created++
		} catch (err) {
			console.error("Lỗi ghi page Notion:", err)
		}
	}
	return created
}

// ─────────────────────────────────────────────
// WEBHOOK: investigateCompetitors
// ─────────────────────────────────────────────

worker.webhook("investigateCompetitors", {
	title: "Điều tra thông tin đối thủ",
	description:
		"Kích hoạt bởi nút 'Điều tra thông tin' trên 1 dòng trong database Yêu cầu báo cáo. Quét toàn bộ watchlist theo khoảng ngày, ghi kết quả vào Bảng 2, tạo Google Doc tóm tắt.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			const pageId = event.body?.page_id as string | undefined
			if (!pageId) {
				console.error("investigateCompetitors: thiếu page_id trong payload")
				continue
			}

			// ── Bước 1: Đọc thông tin yêu cầu ──────────────────────────────
			let fromDate: string | undefined
			let toDate: string | undefined
			let requestName = "Báo cáo"

			try {
				const page = await notion.pages.retrieve({ page_id: pageId })
				const props = (
					page as {
						properties: Record<
							string,
							{
								title?: Array<{ plain_text?: string }>
								date?: { start?: string }
								select?: { name?: string }
							}
						>
					}
				).properties
				fromDate = props["Từ ngày"]?.date?.start
				toDate = props["Đến ngày"]?.date?.start
				requestName = props["Tên yêu cầu"]?.title?.[0]?.plain_text ?? "Báo cáo"
			} catch (err) {
				console.error("Lỗi đọc trang yêu cầu:", err)
				continue
			}

			if (!fromDate || !toDate) {
				console.error("investigateCompetitors: thiếu Từ ngày hoặc Đến ngày")
				continue
			}

			// Fail fast: validate API key trước khi gọi bất kỳ API tốn quota nào (Nguyên tắc 1.3)
			if (!GEMINI_API_KEY) {
				console.error("investigateCompetitors: GEMINI_API_KEY chưa cấu hình — dừng để tránh tốn chi phí")
				continue
			}

			// ── Bước 2: Đánh dấu "Đang xử lý" ──────────────────────────────
			try {
				await notion.pages.update({
					page_id: pageId,
					properties: { "Trạng thái": { select: { name: "Đang xử lý" } } },
				})
			} catch (err) {
				console.error("Lỗi cập nhật trạng thái:", err)
			}

			// ── Bước 3: Đọc toàn bộ Danh sách theo dõi ─────────────────────
			let watchlistEntries: WatchlistEntry[] = []
			try {
				const wlSearch = await notion.search({
					query: "Danh sách theo dõi",
					filter: { value: "data_source", property: "object" },
				})
				const wlDs = wlSearch.results.find((r) => r.object === "data_source")
				if (wlDs) {
					const wlPages = await notion.dataSources.query({
						data_source_id: wlDs.id,
						page_size: 50, // Giới hạn tối đa — tránh watchlist quá lớn làm treo lượt chạy (Nguyên tắc 2.2)
					})
					watchlistEntries = wlPages.results
						.filter((p) => p.object === "page")
						.map((p) => {
							const props = (
								p as {
									properties: Record<
										string,
										{
											title?: Array<{ plain_text?: string }>
											rich_text?: Array<{ plain_text?: string }>
											select?: { name?: string }
											url?: string
										}
									>
								}
							).properties
							return {
								pageId: p.id,
								id: props["ID"]?.rich_text?.[0]?.plain_text ?? p.id,
								name: props["Tên kênh/Website"]?.title?.[0]?.plain_text ?? "Unknown",
								type: (props["Loại"]?.select?.name === "YouTube"
									? "YouTube"
									: "Website") as "YouTube" | "Website",
								link: props["Link"]?.url ?? "",
								threatenedProduct: props["Sản phẩm bị đe dọa"]?.select?.name ?? "Unknown",
								solutionArea: props["Mảng giải pháp"]?.select?.name ?? "Unknown",
							}
						})
						.filter((e) => e.link !== "")
				}
			} catch (err) {
				console.error("Lỗi đọc watchlist:", err)
			}

			if (watchlistEntries.length === 0) {
				console.log("Không có nguồn nào trong Danh sách theo dõi.")
			}

			// ── Bước 4–6: Quét YouTube / Website / Bên thứ 3 ───────────────
			const allItems: ProcessedItem[] = []

			for (const entry of watchlistEntries.filter((e) => e.type === "YouTube")) {
				try {
					const items = await scanYouTubeChannel(entry, fromDate, toDate)
					allItems.push(...items)
					console.log(`YouTube [${entry.name}]: ${items.length} video`)
				} catch (err) {
					console.error(`Lỗi scan YouTube [${entry.name}]:`, err)
				}
			}

			for (const entry of watchlistEntries.filter((e) => e.type === "Website")) {
				try {
					const items = await scanWebsite(entry, fromDate, toDate)
					allItems.push(...items)
					console.log(`Website [${entry.name}]: ${items.length} thay đổi`)
				} catch (err) {
					console.error(`Lỗi scan website [${entry.name}]:`, err)
				}
			}

			const uniqueSubjects = [...new Set(watchlistEntries.map((e) => e.name))]
			for (const subjectName of uniqueSubjects) {
				const entry = watchlistEntries.find((e) => e.name === subjectName)!
				try {
					const items = await scanThirdPartyMentions(
						subjectName,
						fromDate,
						toDate,
						entry.threatenedProduct,
						entry.solutionArea,
					)
					allItems.push(...items)
					console.log(`Bên thứ 3 [${subjectName}]: ${items.length} mentions`)
				} catch (err) {
					console.error(`Lỗi scan mentions [${subjectName}]:`, err)
				}
			}

			// ── Bước 7: Ghi vào Bảng 2 (idempotent — skip trùng theo eventId) ──
			let created = 0
			try {
				const logSearch = await notion.search({
					query: "Theo dõi Đối thủ Cạnh tranh",
					filter: { value: "data_source", property: "object" },
				})
				const logDs = logSearch.results.find((r) => r.object === "data_source")
				if (logDs) {
					// Lấy Event ID đã tồn tại trong khoảng ngày để skip trùng (Nguyên tắc 1.2 — Idempotency)
					const existingIds = new Set<string>()
					try {
						const existingRes = await notion.dataSources.query({
							data_source_id: logDs.id,
							filter: {
								and: [
									{ property: "Ngày phát hiện", date: { on_or_after: fromDate } },
									{ property: "Ngày phát hiện", date: { on_or_before: toDate } },
								],
							},
							page_size: 100,
						})
						for (const p of existingRes.results) {
							if (p.object !== "page") continue
							const props = (p as { properties: Record<string, { rich_text?: Array<{ plain_text?: string }> }> }).properties
							const eid = props["Event ID"]?.rich_text?.[0]?.plain_text
							if (eid) existingIds.add(eid)
						}
						console.log(`Đã có ${existingIds.size} sự kiện trong khoảng ngày — sẽ bỏ qua trùng.`)
					} catch (err) {
						console.error("Lỗi kiểm tra trùng Event ID:", err)
					}
					created = await writeItemsToNotionDb(allItems, logDs.id, notion, existingIds)
					console.log(`Ghi ${created}/${allItems.length} sự kiện vào Bảng 2.`)
				} else {
					console.error("Không tìm thấy database 'Theo dõi Đối thủ Cạnh tranh'.")
				}
			} catch (err) {
				console.error("Lỗi tìm database Bảng 2:", err)
			}

			// ── Bước 8: Gemini viết tóm tắt điều hành ───────────────────────
			let executiveSummary = `Không có dữ liệu trong khoảng ${fromDate} đến ${toDate}.`
			if (allItems.length > 0) {
				const dataText = allItems
					.map(
						(r, i) =>
							`${i + 1}. [${r.urgency}] ${r.subjectName} — ${r.shortTitle} (${r.classification}, ${r.publishedAt.slice(0, 10)})\n   Tác động: ${r.impact}`,
					)
					.join("\n")

				const summaryPrompt = `Viết tóm tắt điều hành ngắn gọn (3-5 đoạn, tiếng Việt) cho báo cáo theo dõi đối thủ cạnh tranh từ ${fromDate} đến ${toDate}. Nêu bật điểm nổi bật, xu hướng, và khuyến nghị:\n\n${dataText}`

				try {
					await geminiPacer.wait()
					const gemRes = await fetch(
						`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								contents: [{ parts: [{ text: summaryPrompt }] }],
								generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
							}),
							signal: AbortSignal.timeout(30000),
						},
					)
					const gemData = (await gemRes.json()) as {
						candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
					}
					executiveSummary =
						gemData.candidates?.[0]?.content?.parts?.[0]?.text ?? executiveSummary
				} catch (err) {
					console.error("Lỗi Gemini tóm tắt:", err)
				}
			}

			// ── Bước 9: Tạo Google Doc qua Composio ─────────────────────────
			const docTitle = `${requestName} — ${fromDate} đến ${toDate}`
			const tableRows = allItems
				.map(
					(r) =>
						`| ${r.publishedAt.slice(0, 10)} | ${r.subjectName} | ${r.shortTitle} | ${r.classification} | ${r.urgency} | ${r.impact} | ${r.link} |`,
				)
				.join("\n")

			const docContent = `# ${docTitle}

## Tóm tắt điều hành

${executiveSummary}

## Chi tiết sự kiện (${allItems.length} mục)

| Ngày | Chủ thể | Tiêu đề | Phân loại | Mức độ | Tác động | Link |
|------|---------|---------|-----------|--------|----------|------|
${tableRows || "_(Không có dữ liệu trong khoảng này)_"}

---
*Báo cáo tạo tự động bởi Notion Worker — Theo dõi Đối thủ Cạnh tranh*`

			let docUrl: string | undefined
			try {
				const composioRes = await fetch(
					"https://backend.composio.dev/api/v1/actions/googledocs_create_document/execute",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-api-key": COMPOSIO_API_KEY,
						},
						body: JSON.stringify({
							input: { title: docTitle, text: docContent },
						}),
						signal: AbortSignal.timeout(30000),
					},
				)
				if (composioRes.ok) {
					const composioData = (await composioRes.json()) as {
						data?: { documentId?: string; document_url?: string }
					}
					const docId = composioData.data?.documentId
					docUrl =
						composioData.data?.document_url ??
						(docId ? `https://docs.google.com/document/d/${docId}/edit` : undefined)
					console.log("Google Doc tạo thành công:", docUrl)
				} else {
					console.error("Composio lỗi:", composioRes.status, await composioRes.text())
				}
			} catch (err) {
				console.error("Lỗi gọi Composio:", err)
			}

			// ── Bước 10: Ghi ngược kết quả vào page yêu cầu ─────────────────
			try {
				await notion.pages.update({
					page_id: pageId,
					properties: {
						"Trạng thái": { select: { name: "Xong" } },
						...(docUrl ? { "Link báo cáo": { url: docUrl } } : {}),
					},
				})
				console.log(`Hoàn tất: ${docTitle} (${allItems.length} sự kiện, ${created} đã ghi vào Notion)`)
			} catch (err) {
				console.error("Lỗi ghi ngược kết quả:", err)
			}
		}
	},
})

// ─────────────────────────────────────────────
// TOOL: scanChannelNow
// ─────────────────────────────────────────────

worker.tool("scanChannelNow", {
	title: "Quét gấp 1 kênh/website",
	description:
		"Quét ngay lập tức 1 kênh YouTube hoặc website cụ thể theo yêu cầu, ghi kết quả vào database Theo dõi Đối thủ Cạnh tranh.",
	schema: j.object({
		url: j.string().describe("Link kênh YouTube hoặc website cần quét gấp"),
		subjectName: j.string().describe("Tên đối thủ/KOL tương ứng với link này"),
		threatenedProduct: j.string().describe("Tên sản phẩm bị đe dọa"),
		solutionArea: j.string().describe("Tên mảng giải pháp"),
	}),
	execute: async ({ url, subjectName, threatenedProduct, solutionArea }, { notion }) => {
		const isYouTube =
			url.includes("youtube.com") || url.includes("youtu.be") || url.includes("/@")

		const entry: WatchlistEntry = {
			pageId: "tool-run",
			id: hashString(url),
			name: subjectName,
			type: isYouTube ? "YouTube" : "Website",
			link: url,
			threatenedProduct: threatenedProduct ?? "Unknown",
			solutionArea: solutionArea ?? "Unknown",
		}

		// Default: quét 7 ngày gần nhất
		const endDate = new Date().toISOString()
		const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

		let items: ProcessedItem[]
		if (isYouTube) {
			items = await scanYouTubeChannel(entry, startDate, endDate)
		} else {
			items = await scanWebsite(entry, startDate, endDate)
		}

		// Tìm data_source competitorLog để ghi trực tiếp qua Notion API
		const searchRes = await notion.search({
			query: "Theo dõi Đối thủ Cạnh tranh",
			filter: { value: "data_source", property: "object" },
		})
		const ds = searchRes.results.find((r) => r.object === "data_source")

		if (!ds) {
			return {
				summary:
					"❌ Không tìm thấy database 'Theo dõi Đối thủ Cạnh tranh'. Hãy đảm bảo bạn đã tạo database này trong Notion.",
			}
		}

		// Kiểm tra Event ID trùng trong 7 ngày gần nhất (Nguyên tắc 1.2 — Idempotency)
		const existingIds = new Set<string>()
		try {
			const existingRes = await notion.dataSources.query({
				data_source_id: ds.id,
				filter: { property: "Ngày phát hiện", date: { on_or_after: startDate } },
				page_size: 100,
			})
			for (const p of existingRes.results) {
				if (p.object !== "page") continue
				const props = (p as { properties: Record<string, { rich_text?: Array<{ plain_text?: string }> }> }).properties
				const eid = props["Event ID"]?.rich_text?.[0]?.plain_text
				if (eid) existingIds.add(eid)
			}
		} catch (err) {
			console.error("Lỗi kiểm tra trùng:", err)
		}

		const created = await writeItemsToNotionDb(items, ds.id, notion, existingIds)

		return {
			summary: `✅ Quét xong ${subjectName} (${entry.type}): ${items.length} sự kiện phát hiện, ghi thành công ${created} vào Notion.`,
		}
	},
})
