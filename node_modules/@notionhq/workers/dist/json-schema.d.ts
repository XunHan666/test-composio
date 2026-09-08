/**
 * JSON Schema types compatible with both Anthropic and OpenAI structured
 * output APIs.
 *
 * Constraints enforced by this type (intersection of both providers):
 * - Objects must have `additionalProperties: false`
 * - All object properties should be listed in `required`
 *   (use `anyOf` with `null` for optional fields)
 * - No recursive schemas
 * - No `allOf`, `not`, `if/then/else`
 * - No string constraints (`minLength`, `maxLength`, `pattern`)
 * - No number constraints (`minimum`, `maximum`, `multipleOf`)
 * - Array `minItems` limited to 0 or 1; no `maxItems`
 * - String `format` limited to: date-time, time, date, duration,
 *   email, hostname, ipv4, ipv6, uuid
 * - `$ref` and `$defs` supported (no external refs)
 */
/**
 * String formats supported by both Anthropic and OpenAI structured outputs.
 */
export type JSONSchemaStringFormat = "date-time" | "time" | "date" | "duration" | "email" | "hostname" | "ipv4" | "ipv6" | "uuid";
interface ForbiddenCompositionKeywords {
    anyOf?: never;
    allOf?: never;
    not?: never;
    if?: never;
    then?: never;
    else?: never;
}
export interface JSONSchemaStringDef<T extends string = string> extends ForbiddenCompositionKeywords {
    type: "string";
    description?: string;
    format?: JSONSchemaStringFormat;
    enum?: readonly T[];
}
export interface JSONSchemaNumberDef<T extends number = number> extends ForbiddenCompositionKeywords {
    type: "number" | "integer";
    description?: string;
    enum?: readonly T[];
}
export interface JSONSchemaBooleanDef extends ForbiddenCompositionKeywords {
    type: "boolean";
    description?: string;
}
export interface JSONSchemaNullDef extends ForbiddenCompositionKeywords {
    type: "null";
    description?: string;
}
export interface JSONSchemaArrayDef<E = unknown> extends ForbiddenCompositionKeywords {
    type: "array";
    description?: string;
    items: JSONSchema<E>;
    minItems?: 0 | 1;
}
export interface JSONSchemaObjectDef<T extends Record<string, unknown> = Record<string, unknown>> extends ForbiddenCompositionKeywords {
    type: "object";
    description?: string;
    properties: {
        [K in keyof T]-?: JSONSchema<T[K]>;
    };
    required: readonly (keyof T & string)[];
    additionalProperties: false;
    $defs?: Record<string, AnyJSONSchema>;
}
export interface JSONSchemaRefDef extends ForbiddenCompositionKeywords {
    $ref: string;
    description?: string;
}
export interface JSONSchemaAnyOfDef<T = unknown> {
    anyOf: readonly JSONSchema<T>[];
    description?: string;
}
export type AnyJSONSchema = JSONSchemaStringDef | JSONSchemaNumberDef | JSONSchemaBooleanDef | JSONSchemaNullDef | JSONSchemaArrayDef | JSONSchemaObjectDef | JSONSchemaRefDef | JSONSchemaAnyOfDef;
/**
 * Maps a TypeScript type T to its corresponding JSON Schema definition.
 *
 * Uses `[T] extends [X]` (non-distributing) so that union types like
 * `string | number` fall through to `AnyJSONSchema` instead of distributing
 * into `JSONSchemaStringDef | JSONSchemaNumberDef`.
 *
 * The `T & X` intersections (e.g. `T & string`) satisfy the generic
 * constraints on each def without widening T.
 *
 * A `$ref` is always valid in any schema position, so `JSONSchemaRefDef`
 * is unioned in at the end.
 */
type JSONSchemaFor<T> = JSONSchemaRefDef | ([T] extends [string] ? JSONSchemaStringDef<T & string> : [T] extends [number] ? JSONSchemaNumberDef<T & number> : [T] extends [boolean] ? JSONSchemaBooleanDef : [T] extends [readonly (infer E)[]] ? JSONSchemaArrayDef<E> : [T] extends [Record<string, unknown>] ? JSONSchemaObjectDef<T & Record<string, unknown>> : AnyJSONSchema);
/**
 * Wraps a non-null schema in an `anyOf` with `{ type: "null" }` for
 * nullable types (e.g. `string | null`).
 */
type JSONSchemaNullable<T> = {
    anyOf: readonly [JSONSchemaFor<T>, JSONSchemaNullDef];
    description?: string;
};
/**
 * A JSON Schema definition compatible with both Anthropic and OpenAI
 * structured output APIs.
 *
 * When the generic parameter `T` is provided, the schema structure is
 * constrained at compile time to match `T`:
 *
 * ```ts
 * // Schema is checked against the type:
 * const schema: JSONSchema<{ name: string }> = {
 *   type: "object",
 *   properties: { name: { type: "string" } },
 *   required: ["name"],
 *   additionalProperties: false,
 * };
 * ```
 *
 * @template T - The TypeScript type the schema should describe.
 */
export type JSONSchema<T = unknown> = unknown extends T ? AnyJSONSchema : null extends T ? JSONSchemaNullable<NonNullable<T>> : JSONSchemaFor<T>;
export {};
//# sourceMappingURL=json-schema.d.ts.map