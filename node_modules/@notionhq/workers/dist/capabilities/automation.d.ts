import type { HandlerOptions } from "../types.js";
import type { CapabilityContext } from "./context.js";
/**
 * Event provided to automation execute functions
 */
export interface AutomationEvent {
    /**
     * The ID of the page that triggered the automation (if applicable)
     */
    pageId?: string;
    /**
     * The type of automation action that was triggered
     */
    actionType: string;
    /**
     * The full page object from Notion's Public API (if triggered by a database page)
     */
    pageData?: PageObjectResponse;
}
/**
 * Page object from Notion's Public API
 * This represents a database page with all its properties.
 * Properties are in Notion's Public API format.
 * See: https://developers.notion.com/reference/page
 */
export interface PageObjectResponse {
    object: "page";
    id: string;
    created_time: string;
    last_edited_time: string;
    created_by: {
        id: string;
    };
    last_edited_by: {
        id: string;
    };
    cover: unknown;
    icon: unknown;
    parent: unknown;
    archived: boolean;
    properties: Record<string, unknown>;
    url: string;
    public_url?: string | null;
}
/**
 * Configuration for an automation capability
 */
export interface AutomationConfiguration {
    /**
     * Title of the automation - shown in the UI when selecting automations
     */
    title: string;
    /**
     * Description of what this automation does - shown in the UI
     */
    description: string;
    /**
     * The function that executes when the automation is triggered
     * @param event - Event data about the automation trigger, including page data if applicable
     * @param context - The capability execution context (Notion client, etc.)
     * @returns A promise that resolves when the automation completes
     */
    execute: (event: AutomationEvent, context: CapabilityContext) => Promise<void> | void;
}
/**
 * Result returned from automation execution
 */
export interface AutomationHandlerResult {
    title: string;
    description: string;
}
export type AutomationCapability = ReturnType<typeof createAutomationCapability>;
/**
 * Creates an automation capability from configuration.
 *
 * @param key - The unique name for this capability.
 * @param config - The automation configuration.
 * @returns The capability object.
 */
export declare function createAutomationCapability(key: string, config: AutomationConfiguration): {
    _tag: "automation";
    key: string;
    config: {
        title: string;
        description: string;
    };
    handler(event: AutomationEvent, options?: HandlerOptions): Promise<{
        status: "success";
    } | undefined>;
};
//# sourceMappingURL=automation.d.ts.map