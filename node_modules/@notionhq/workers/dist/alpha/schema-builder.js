const SCHEMA = /* @__PURE__ */ Symbol("schema");
function getSchema(builder) {
  return builder[SCHEMA];
}
function makeBuilder(schema) {
  return {
    [SCHEMA]: schema,
    describe(text) {
      return makeBuilder({ ...schema, description: text });
    },
    nullable() {
      const { description: desc, ...rest } = schema;
      const inner = desc !== void 0 ? rest : schema;
      const wrapper = {
        anyOf: [inner, { type: "null" }]
      };
      if (desc !== void 0) wrapper.description = desc;
      return makeBuilder(wrapper);
    }
  };
}
function string() {
  return makeBuilder({ type: "string" });
}
function number() {
  return makeBuilder({ type: "number" });
}
function integer() {
  return makeBuilder({ type: "integer" });
}
function boolean() {
  return makeBuilder({ type: "boolean" });
}
function enumBuilder(...values) {
  const type = typeof values[0] === "string" ? "string" : "number";
  return makeBuilder({ type, enum: values });
}
function datetime() {
  return makeBuilder({ type: "string", format: "date-time" });
}
function date() {
  return makeBuilder({ type: "string", format: "date" });
}
function time() {
  return makeBuilder({ type: "string", format: "time" });
}
function duration() {
  return makeBuilder({ type: "string", format: "duration" });
}
function email() {
  return makeBuilder({ type: "string", format: "email" });
}
function hostname() {
  return makeBuilder({ type: "string", format: "hostname" });
}
function ipv4() {
  return makeBuilder({ type: "string", format: "ipv4" });
}
function ipv6() {
  return makeBuilder({ type: "string", format: "ipv6" });
}
function uuid() {
  return makeBuilder({ type: "string", format: "uuid" });
}
function array(items, options) {
  const schema = {
    type: "array",
    items: getSchema(items)
  };
  if (options?.minItems !== void 0) schema.minItems = options.minItems;
  return makeBuilder(schema);
}
function object(properties) {
  const schemaProps = {};
  const keys = Object.keys(properties);
  for (const key of keys) {
    schemaProps[key] = getSchema(properties[key]);
  }
  return makeBuilder({
    type: "object",
    properties: schemaProps,
    required: keys,
    additionalProperties: false
  });
}
function anyOf(...schemas) {
  return makeBuilder({
    anyOf: schemas.map(getSchema)
  });
}
function ref(path) {
  return makeBuilder({ $ref: path });
}
const j = {
  string,
  number,
  integer,
  boolean,
  enum: enumBuilder,
  datetime,
  date,
  time,
  duration,
  email,
  hostname,
  ipv4,
  ipv6,
  uuid,
  array,
  object,
  anyOf,
  ref
};
export {
  anyOf,
  array,
  boolean,
  date,
  datetime,
  duration,
  email,
  enumBuilder as enum,
  getSchema,
  hostname,
  integer,
  ipv4,
  ipv6,
  j,
  number,
  object,
  ref,
  string,
  time,
  uuid
};
