function createOAuthCapability(key, config) {
  const envKey = oauthNameToEnvKey(config.name);
  if ("provider" in config) {
    return {
      _tag: "oauth",
      key,
      envKey,
      async accessToken() {
        return readRequiredEnvVar(envKey, { name: config.name });
      },
      config: {
        type: "notion_managed",
        name: config.name,
        provider: config.provider,
        accessTokenExpireMs: config.accessTokenExpireMs
      }
    };
  }
  return {
    _tag: "oauth",
    key,
    envKey,
    async accessToken() {
      return readRequiredEnvVar(envKey, { name: config.name });
    },
    config: {
      type: "user_managed",
      name: config.name,
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      scope: config.scope,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authorizationParams: config.authorizationParams,
      callbackUrl: config.callbackUrl,
      accessTokenExpireMs: config.accessTokenExpireMs
    }
  };
}
function oauthNameToEnvKey(identifier) {
  const encoded = Buffer.from(identifier).toString("hex").toUpperCase();
  return `OAUTH_${encoded}_ACCESS_TOKEN`;
}
function readRequiredEnvVar(key, context) {
  const value = process.env[key];
  if (value) {
    return value;
  }
  throw new Error(
    `Missing OAuth access token env var "${key}" (name: "${context.name}"). Make sure you've completed OAuth for this capability and are running inside the worker runtime.`
  );
}
export {
  createOAuthCapability
};
