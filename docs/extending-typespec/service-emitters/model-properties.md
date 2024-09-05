# Service Emitter Handling of ModelProperties and Parameters

## Proposed API Additions

For the purposes of discussion below, assume the

```typescript
type NumericConstraint = {min?: number, max?: number, exclusiveMin?: boolean, exclusiveMax?: boolean};
type Visibility = "read" | "update" | "create" | "list" | "delete";
type HttpMetadataPart: "path" | "query" | "header";
type HttpProtocolInfo= { part: HttpMetadataPart, serializedName?: string};
type MediaType = "application/json" | "multipart/form-data" | "text/plain" | "application/octent-stream" | string;
type Encoding = {propertyName?: string, encodingName?: string, wireType?: type, format?: string};
type PropConstraint =  StringConstraint | NumericConstraint | ArrayConstraint;
type StringConstraint = { length?: NumericConstraint, pattern?: string, secret?: boolean};
type NumericConstraint = { value?: NumericConstraint};
type ArrayConstraint = { count? NumericConstraint }
```

## Acquisition and Handling of Property Metadata

| Property         | Type                     | Description                                                                                       | How to Acquire                                                                                                             | Handling                                                                                                                               | Priority                                  |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| name             | string                   | name of the property in generated public representation                                           | (1) getProjectedName; (2) getFriendlyName; (3) name                                                                        | Translate into valid identifier with appropriate casing (character set, reserved words)                                                | 0                                         |
| isOptional       | boolean                  | Is the property optional                                                                          | isOptional                                                                                                                 | Mark as optional, do not throw if absent when deserializing                                                                            | 0                                         |
| description      | string                   | documentation of the property, may be using markdown                                              | getDoc                                                                                                                     | Prefer Doc over summary for inline code documentation; Remove disallowed characters and format for documentation                       | 0                                         |
| summary          | string                   | Short description of the property                                                                 | getSummary                                                                                                                 | 2                                                                                                                                      |
| type             | Type                     | type of the property                                                                              | type                                                                                                                       | Use with encodings to determine the language-specific logical type                                                                     | 0                                         |
| default          | ValueType                | default value if not provided, or value if this is in the context of a discriminated type default | Set the property to this default when not explicitly provided                                                              | 0                                                                                                                                      |
| encodings        | Map<MediaType, Encoding> | encoding of the property on the wire in wire formats                                              | getEncoding                                                                                                                | Use to encode the property on the wire. If any encoding is not understood, represent the logical type as the wire type                 | 0 (application/json, multipart/form-data) |
| constraints      | PropConstraint           | constraints applied through core decorators get\* accessors                                       | Throw before business logic if constraints are unmet (May need an extensibility point for setting exception/error details) | 1                                                                                                                                      |
| visibility       | Visibility[]             | In what contexts the property appears                                                             | getVisibility                                                                                                              | Provide serializations for the property based on comparing visibility to the parameterVisibility and returnTypeVisibility of its usage | 0                                         |
| isDiscriminator  | boolean                  | Is this the discriminator property                                                                | getDiscriminator (Model)                                                                                                   | Marked this property as the discriminator - generally not represented in the logical type, only in serialization                       | 0                                         |
| httpProtocolInfo | HttpProtocolInfo         | Information about whether this property contains http metadata                                    | get\* methods                                                                                                              | Serialize to/from protocol elements                                                                                                    | 0                                         |
| isDeprecated     | boolean                  | Whether property is deprecated                                                                    | isDeprecated                                                                                                               | No treatment of deprecation for properties                                                                                             | 2                                         |

## Encoding

Emitters must handle the following minimal encodings. Encodings outside this set should result in modeling the logical type of the property as the wire type, and a compile-time warning to note that the encoding is not recognized and must be handled by business logic. Note: need to keep up to date with what we do for content-=type specific encoding (e.g. xml encoding)

| Type            | Default Encoding (json)                                       | Additional Encodings                          |
| --------------- | ------------------------------------------------------------- | --------------------------------------------- |
| utcDateTime     | (payload) json: [rfc3339, string]; headers: [rfc7231, string] | [unixTimeStamp, int32 \| int64]               |
| offsetDateTime  | json: [rfc3339, string]; headers: [rfc7231, string]           | [rfc7231, string]                             |
| unixTimeStamp32 | [unixTimeStamp, int32]                                        | [unixTimeStamp, int64]                        |
| plainDate       | json: [rfc3339, string]; headers: [rfc7231, string]           | [rfc7231, string]                             |
| plainTime       | json: [rfc3339, string]; headers: [rfc7231, string]           | [rfc7231, string]                             |
| bytes           | [base64, string]                                              | [base64Url, string]                           |
| duration        | [ISO8601, string]                                             | [seconds, int32 \| int64 \| uint32 \| uint64] |

## Formats

Formats are a shorthand for pattern constraints on string types over the wire. Services may enforce the implied pattern constraint by throwing before the business logic is called. Some format constraints could also result in different types on the wire. Most format constraints can be safely ignored.

| Format   | Description        | Pattern / Treatment                                                                       | Priority |
| -------- | ------------------ | ----------------------------------------------------------------------------------------- | -------- |
| char     | A single character | length 1 "^.$"                                                                            | 3        |
| password | Sensitive data     | May affect logical type                                                                   | 1        |
| uuid     | Unique identifier  | "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", may affect logical type | 2        |
| uri      | url                | May affect logical type                                                                   | 2        |
