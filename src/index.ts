import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { j } from "@notionhq/workers/schema-builder"
import crypto from "node:crypto"

const worker = new Worker()
export default worker

// ─────────────────────────────────────────────
// ENV VARS
// ─────────────────────────────────────────────
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? ""
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ""
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ?? ""

// ─────────────────────────────────────────────
// DATABASES
// ─────────────────────────────────────────────



/** Database 2: Nhật ký sự kiện đối thủ — bảng kết quả chính */
const competitorLog = worker.database("competitorLog", {
	type: "managed",
	initialTitle: "Theo dõi Đối thủ Cạnh tranh",
	primaryKeyProperty: "Event ID",
	schema: {
		properties: {
			"Tiêu đề": Schema.title(),
			"Event ID": Schema.richText(),
			"Chủ thể": Schema.select([]),
			"Nền tảng": Schema.select([{ name: "YouTube" }, { name: "Website" }, { name: "Bên thứ 3" }]),
			"Phân loại": Schema.select([
				{ name: "Sponsored Video" },
				{ name: "Review" },
				{ name: "New Feature" },
				{ name: "Pricing Change" },
			]),
			"Mức độ khẩn cấp": Schema.select([{ name: "Cao" }, { name: "Theo dõi thêm" }]),
			"Trạng thái xử lý": Schema.select([
				{ name: "Mới" },
				{ name: "Đã xem" },
				{ name: "Đã xử lý" },
			]),
			"Nguồn transcript": Schema.select([
				{ name: "Có" },
				{ name: "Không" },
				{ name: "Chỉ title-description" },
			]),
			"Sản phẩm bị đe dọa": Schema.select([
				{ name: "Cyabra", color: "blue" },
				{ name: "Similarweb", color: "orange" },
				{ name: "Omdia", color: "purple" },
				{ name: "Vicarius (vRx)", color: "red" },
				{ name: "Dịch vụ Local", color: "green" },
			]),
			"Mảng giải pháp": Schema.select([]),
			"Tác động dự kiến": Schema.richText(),
			"Bằng chứng & Link": Schema.url(),
			"Ngày phát hiện": Schema.date(),
		},
	},
})



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
	startDate: string
	endDate: string
	requestScan: boolean
}

interface GeminiAnalysis {
	classification: string
	urgency: "Cao" | "Theo dõi thêm"
	impact: string
	evidence: string
	threatenedProduct: string
	solutionArea: string
}

/** Intermediate type — all scalar values, used for both sync and tool */
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

interface SyncState {
	websiteSnapshots: Record<string, string>
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

Dựa vào danh sách Mapping sau đây để xác định "threatenedProduct" và "solutionArea":
- Cyabra: Blackbird.AI, Alethea (Artemis), Graphika, ZeroFox, ActiveFence
- Similarweb: SEMrush, Ahrefs, Sensor Tower (Data.ai), Comscore
- Omdia: Gartner, IDC, Forrester
- Vicarius (vRx): Qualys (VMDR), Tenable (Nessus), NinjaOne, ManageEngine
- Dịch vụ Local: YouNet Media, Buzzmetrics, Kompa Group, Viettel Cyber Security, VNPT Cyber Immunity

Nếu đối thủ không có trong danh sách trên, hãy tự đoán Threatened Product phù hợp nhất trong 5 lựa chọn trên. 
solutionArea là tên mảng giải pháp bằng tiếng Việt (ví dụ: Lắng nghe mạng xã hội, Tối ưu tìm kiếm, Quản lý lỗ hổng bảo mật...).

Trả về JSON:
{
  "classification": "Sponsored Video" | "Review" | "New Feature" | "Pricing Change",
  "urgency": "Cao" | "Theo dõi thêm",
  "impact": "Nhận định tác động 1-2 câu tiếng Việt",
  "evidence": "Trích dẫn bằng chứng cụ thể từ nội dung",
  "threatenedProduct": "Tên sản phẩm bị đe dọa (Cyabra, Similarweb, Omdia, Vicarius (vRx) hoặc Dịch vụ Local)",
  "solutionArea": "Tên mảng giải pháp bằng tiếng Việt"
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
			threatenedProduct: parsed.threatenedProduct ?? "Unknown",
			solutionArea: parsed.solutionArea ?? "Unknown",
		}
	} catch (err) {
		console.error("Gemini error:", err)
		return {
			classification: "Review",
			urgency: "Theo dõi thêm",
			impact: "Không thể phân tích tự động.",
			evidence: title,
			threatenedProduct: "Unknown",
			solutionArea: "Unknown",
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
async function scanYouTubeChannel(entry: WatchlistEntry): Promise<ProcessedItem[]> {
	const items: ProcessedItem[] = []
	let videos: Array<{ videoId: string; title: string; description: string; publishedAt: string }> = []

	try {
		videos = await fetchRecentYouTubeVideos(entry.link, entry.startDate, entry.endDate)
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
			threatenedProduct: analysis.threatenedProduct,
			solutionArea: analysis.solutionArea,
			transcriptSource: transcript ? "Có" : "Chỉ title-description",
			link: `https://www.youtube.com/watch?v=${video.videoId}`,
			publishedAt: video.publishedAt,
		})
	}

	return items
}

/** Quét 1 website, so sánh với snapshot cũ, trả về ProcessedItems */
async function scanWebsite(
	entry: WatchlistEntry,
	snapshots: Record<string, string>,
): Promise<{ items: ProcessedItem[]; newSnapshot: string }> {
	const content = await fetchWebsiteContent(entry.link)
	if (!content) return { items: [], newSnapshot: snapshots[entry.link] ?? "" }

	const contentHash = hashString(content)
	if (contentHash === (snapshots[entry.link] ?? "")) {
		return { items: [], newSnapshot: contentHash }
	}

	await geminiPacer.wait()
	const analysis = await analyzeWithGemini(
		`Thay đổi website: ${entry.name}`,
		content,
		null,
		entry.name,
	)

	const now = new Date().toISOString()
	return {
		items: [
			{
				eventId: hashString(`web-${entry.link}-${now.slice(0, 10)}`),
				shortTitle: `Thay đổi phát hiện trên ${entry.name}`,
				subjectName: entry.name,
				platform: "Website",
				classification: analysis.classification,
				urgency: analysis.urgency,
				impact: analysis.impact,
				threatenedProduct: analysis.threatenedProduct,
				solutionArea: analysis.solutionArea,
				transcriptSource: "Không",
				link: entry.link,
				publishedAt: now,
			},
		],
		newSnapshot: contentHash,
	}
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

async function scanThirdPartyMentions(subjectName: string, startDate: string, endDate: string): Promise<ProcessedItem[]> {
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
			threatenedProduct: analysis.threatenedProduct,
			solutionArea: analysis.solutionArea,
			transcriptSource: "Không",
			link: mention.url,
			publishedAt: new Date().toISOString(),
		})
	}
	return items
}

// ─────────────────────────────────────────────
// SYNC: competitorScan
// ─────────────────────────────────────────────

worker.sync("competitorScan", {
	database: competitorLog,
	mode: "incremental",
	schedule: "5m",
	execute: async (state: SyncState | undefined, { notion }) => {
		const snapshots: Record<string, string> = state?.websiteSnapshots ?? {}
		const allItems: ProcessedItem[] = []

		// 1. Đọc watchlist đang theo dõi từ Notion
		let watchlistEntries: WatchlistEntry[] = []
		try {
			const searchRes = await notion.search({
				query: "Danh sách theo dõi",
				filter: { value: "data_source", property: "object" },
			})
			const ds = searchRes.results.find((r) => r.object === "data_source")
			if (ds) {
				const pages = await notion.dataSources.query({
					data_source_id: ds.id,
					filter: {
						property: "Đang theo dõi",
						checkbox: { equals: true },
					},
				})
				watchlistEntries = pages.results
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
										date?: { start?: string }
										checkbox?: boolean
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
							startDate: props["Từ ngày"]?.date?.start ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
							endDate: props["Đến ngày"]?.date?.start ?? new Date().toISOString(),
							requestScan: props["Yêu cầu quét ngay"]?.checkbox ?? false,
						}
					})
					.filter((e) => e.link !== "")
			}
		} catch (err) {
			console.error("Lỗi đọc watchlist:", err)
		}

		const requestedEntries = watchlistEntries.filter((e) => e.requestScan)
		if (requestedEntries.length === 0) {
			return { changes: [], hasMore: false, nextState: { websiteSnapshots: snapshots } satisfies SyncState }
		}

		console.log(`Quét ${requestedEntries.length} nguồn có yêu cầu...`)

		// 2. Xử lý kênh YouTube
		for (const entry of requestedEntries.filter((e) => e.type === "YouTube")) {
			try {
				const items = await scanYouTubeChannel(entry)
				allItems.push(...items)
				console.log(`YouTube [${entry.name}]: ${items.length} video mới`)
			} catch (err) {
				console.error(`Lỗi scan YouTube [${entry.name}]:`, err)
			}
		}

		// 3. Xử lý website
		const newSnapshots: Record<string, string> = { ...snapshots }
		for (const entry of requestedEntries.filter((e) => e.type === "Website")) {
			try {
				const { items, newSnapshot } = await scanWebsite(entry, snapshots)
				allItems.push(...items)
				newSnapshots[entry.link] = newSnapshot
				console.log(`Website [${entry.name}]: ${items.length} thay đổi`)
			} catch (err) {
				console.error(`Lỗi scan website [${entry.name}]:`, err)
			}
		}

		// 4. Tìm kiếm mentions qua bên thứ 3 bằng Gemini Grounding (dupe filtering)
		const uniqueSubjects = [...new Set(requestedEntries.map((e) => e.name))]
		for (const subjectName of uniqueSubjects) {
			const relatedEntries = requestedEntries.filter((e) => e.name === subjectName)
			// Lấy startDate xa nhất và endDate gần nhất
			const minStartDate = relatedEntries.reduce((min, e) => e.startDate < min ? e.startDate : min, relatedEntries[0].startDate)
			const maxEndDate = relatedEntries.reduce((max, e) => e.endDate > max ? e.endDate : max, relatedEntries[0].endDate)
			try {
				const items = await scanThirdPartyMentions(subjectName, minStartDate, maxEndDate)
				allItems.push(...items)
			} catch (err) {
				console.error(`Lỗi scan mentions [${subjectName}]:`, err)
			}
		}

		// Xóa tick "Yêu cầu quét ngay" trên Notion
		for (const entry of requestedEntries) {
			try {
				await notion.pages.update({
					page_id: entry.pageId,
					properties: {
						"Yêu cầu quét ngay": { checkbox: false }
					}
				})
			} catch (e) {
				console.error("Lỗi xóa tick:", e)
			}
		}

		// 5. Build changes với proper typing inline (TypeScript infers từ database schema)
		return {
			changes: allItems.map((item) => ({
				type: "upsert" as const,
				key: item.eventId,
				properties: {
					"Tiêu đề": Builder.title(item.shortTitle.slice(0, 200)),
					"Event ID": Builder.richText(item.eventId),
					"Chủ thể": Builder.select(item.subjectName),
					"Nền tảng": Builder.select(item.platform),
					"Phân loại": Builder.select(item.classification),
					"Mức độ khẩn cấp": Builder.select(item.urgency),
					"Sản phẩm bị đe dọa": Builder.select(item.threatenedProduct),
					"Mảng giải pháp": Builder.select(item.solutionArea),
					"Trạng thái xử lý": Builder.select("Mới"),
					"Nguồn transcript": Builder.select(item.transcriptSource),
					"Tác động dự kiến": Builder.richText(item.impact.slice(0, 2000)),
					"Bằng chứng & Link": Builder.url(item.link),
					"Ngày phát hiện": Builder.dateTime(item.publishedAt, "Asia/Ho_Chi_Minh"),
				},
			})),
			hasMore: false,
			nextState: { websiteSnapshots: newSnapshots } satisfies SyncState,
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
	}),
	execute: async ({ url, subjectName }, { notion }) => {
		const isYouTube =
			url.includes("youtube.com") || url.includes("youtu.be") || url.includes("/@")

		const entry: WatchlistEntry = {
			pageId: "tool-run",
			id: hashString(url),
			name: subjectName,
			type: isYouTube ? "YouTube" : "Website",
			link: url,
			startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // Default 7 days
			endDate: new Date().toISOString(),
			requestScan: true,
		}

		let items: ProcessedItem[]
		if (isYouTube) {
			items = await scanYouTubeChannel(entry)
		} else {
			const result = await scanWebsite(entry, {})
			items = result.items
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
					"❌ Không tìm thấy database 'Theo dõi Đối thủ Cạnh tranh'. Hãy deploy worker trước.",
			}
		}

		let created = 0
		for (const item of items) {
			try {
				await notion.pages.create({
					parent: { database_id: ds.id },
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

		return {
			summary: `✅ Quét xong ${subjectName} (${entry.type}): ${items.length} sự kiện phát hiện, ghi thành công ${created} vào Notion.`,
		}
	},
})

// ─────────────────────────────────────────────
// WEBHOOK: generateReport
// ─────────────────────────────────────────────

worker.webhook("generateReport", {
	title: "Sinh báo cáo theo khoảng ngày",
	description:
		"Nhận trigger từ Notion khi có yêu cầu báo cáo mới, tổng hợp dữ liệu và tạo Google Doc qua Composio.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			const pageId = event.body?.page_id as string | undefined
			if (!pageId) {
				console.error("generateReport: thiếu page_id trong payload")
				continue
			}

			// 1. Đọc thông tin yêu cầu báo cáo
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
				console.error("Lỗi đọc trang yêu cầu báo cáo:", err)
				continue
			}

			if (!fromDate || !toDate) {
				console.error("generateReport: thiếu Từ ngày hoặc Đến ngày")
				continue
			}

			// Đánh dấu "Đang xử lý"
			try {
				await notion.pages.update({
					page_id: pageId,
					properties: { "Trạng thái": { select: { name: "Đang xử lý" } } },
				})
			} catch (err) {
				console.error("Lỗi cập nhật trạng thái:", err)
			}

			// 2. Query competitorLog trong khoảng ngày
			type LogRow = {
				title: string
				subject: string
				platform: string
				classification: string
				urgency: string
				impact: string
				link: string
				date: string
			}
			const logRows: LogRow[] = []

			try {
				const logSearch = await notion.search({
					query: "Theo dõi Đối thủ Cạnh tranh",
					filter: { value: "data_source", property: "object" },
				})
				const logDs = logSearch.results.find((r) => r.object === "data_source")
				if (logDs) {
					const queryRes = await notion.dataSources.query({
						data_source_id: logDs.id,
						filter: {
							and: [
								{ property: "Ngày phát hiện", date: { on_or_after: fromDate } },
								{ property: "Ngày phát hiện", date: { on_or_before: toDate } },
							],
						},
						sorts: [{ property: "Ngày phát hiện", direction: "descending" }],
					})
					for (const p of queryRes.results) {
						if (p.object !== "page") continue
						const props = (
							p as {
								properties: Record<
									string,
									{
										title?: Array<{ plain_text?: string }>
										rich_text?: Array<{ plain_text?: string }>
										select?: { name?: string }
										url?: string
										date?: { start?: string }
									}
								>
							}
						).properties
						logRows.push({
							title: props["Tiêu đề"]?.title?.[0]?.plain_text ?? "",
							subject: props["Chủ thể"]?.select?.name ?? "",
							platform: props["Nền tảng"]?.select?.name ?? "",
							classification: props["Phân loại"]?.select?.name ?? "",
							urgency: props["Mức độ khẩn cấp"]?.select?.name ?? "",
							impact: props["Tác động dự kiến"]?.rich_text?.[0]?.plain_text ?? "",
							link: props["Bằng chứng & Link"]?.url ?? "",
							date: props["Ngày phát hiện"]?.date?.start ?? "",
						})
					}
				}
			} catch (err) {
				console.error("Lỗi query competitorLog:", err)
			}

			// 3. Gemini viết tóm tắt điều hành
			let executiveSummary = `Không có dữ liệu trong khoảng ${fromDate} đến ${toDate}.`
			if (logRows.length > 0) {
				const dataText = logRows
					.map(
						(r, i) =>
							`${i + 1}. [${r.urgency}] ${r.subject} — ${r.title} (${r.classification}, ${r.date})\n   Tác động: ${r.impact}`,
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

			// 4. Tạo Google Doc qua Composio
			const docTitle = `${requestName} — ${fromDate} đến ${toDate}`
			const tableRows = logRows
				.map(
					(r) =>
						`| ${r.date.slice(0, 10)} | ${r.subject} | ${r.title} | ${r.classification} | ${r.urgency} | ${r.impact} | ${r.link} |`,
				)
				.join("\n")

			const docContent = `# ${docTitle}

## Tóm tắt điều hành

${executiveSummary}

## Chi tiết sự kiện (${logRows.length} mục)

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

			// 5. Ghi ngược kết quả vào page yêu cầu
			try {
				await notion.pages.update({
					page_id: pageId,
					properties: {
						"Trạng thái": { select: { name: "Xong" } },
						...(docUrl ? { "Link báo cáo": { url: docUrl } } : {}),
					},
				})
				console.log(`Báo cáo hoàn tất: ${docTitle} (${logRows.length} sự kiện)`)
			} catch (err) {
				console.error("Lỗi ghi ngược kết quả:", err)
			}
		}
	},
})


