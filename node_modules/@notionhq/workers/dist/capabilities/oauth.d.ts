/**
 * Configuration for a Notion-managed OAuth provider.
 *
 * Notion owns the OAuth app credentials (client ID/secret) and the backend has
 * pre-configured provider settings.
 */
export interface NotionManagedOAuthConfiguration {
    /**
     * The unique identifier for this OAuth provider instance.
     */
    name: string;
    /**
     * The pre-configured provider to use (e.g., "google", "github", "salesforce").
     * The backend will use this to look up the OAuth configuration.
     */
    provider: string;
    /**
     * Optional default access token expiry (in milliseconds) to use when the OAuth provider
     * does not return `expires_in` in token responses.
     *
     * Some providers (e.g. Salesforce in certain configurations) may omit expiry information.
     */
    accessTokenExpireMs?: number;
}
/**
 * Configuration for a user-managed OAuth provider.
 *
 * You own the OAuth app credentials and must explicitly provide endpoints and
 * other OAuth parameters.
 */
export interface UserManagedOAuthConfiguration {
    /**
     * The unique identifier for this OAuth provider instance.
     */
    name: string;
    /**
     * The client ID for the OAuth app.
     */
    clientId: string;
    /**
     * The client secret for the OAuth app.
     */
    clientSecret: string;
    /**
     * The OAuth 2.0 authorization endpoint URL.
     */
    authorizationEndpoint: string;
    /**
     * The OAuth 2.0 token endpoint URL.
     */
    tokenEndpoint: string;
    /**
     * The OAuth scope(s) to request.
     */
    scope: string;
    /**
     * Optional additional authorization parameters to include in the authorization request.
     */
    authorizationParams?: Record<string, string>;
    /**
     * Optional callback URL for OAuth redirect.
     */
    callbackUrl?: string;
    /**
     * Optional default access token expiry (in milliseconds) to use when the OAuth provider
     * does not return `expires_in` in token responses.
     *
     * Some providers (e.g. Salesforce in certain configurations) may omit expiry information.
     */
    accessTokenExpireMs?: number;
}
/**
 * Union type representing either Notion-managed or user-managed OAuth configuration.
 */
export type OAuthConfiguration = NotionManagedOAuthConfiguration | UserManagedOAuthConfiguration;
export type OAuthCapability = ReturnType<typeof createOAuthCapability>;
/**
 * Creates an OAuth provider configuration for authenticating with third-party services.
 *
 * @param config - The OAuth configuration (Notion-managed or user-managed).
 * @returns An OAuth provider definition.
 */
export declare function createOAuthCapability(key: string, config: OAuthConfiguration): {
    _tag: "oauth";
    key: string;
    envKey: string;
    accessToken(): Promise<string>;
    config: {
        type: "notion_managed";
        name: string;
        provider: string;
        accessTokenExpireMs: number | undefined;
        authorizationEndpoint?: never;
        tokenEndpoint?: never;
        scope?: never;
        clientId?: never;
        clientSecret?: never;
        authorizationParams?: never;
        callbackUrl?: never;
    };
} | {
    _tag: "oauth";
    key: string;
    envKey: string;
    accessToken(): Promise<string>;
    config: {
        type: "user_managed";
        name: string;
        authorizationEndpoint: string;
        tokenEndpoint: string;
        scope: string;
        clientId: string;
        clientSecret: string;
        authorizationParams: Record<string, string> | undefined;
        callbackUrl: string | undefined;
        accessTokenExpireMs: number | undefined;
        provider?: never;
    };
};
//# sourceMappingURL=oauth.d.ts.map