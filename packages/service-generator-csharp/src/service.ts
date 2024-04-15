import {
  BooleanLiteral,
  EmitContext,
  Enum,
  Interface,
  IntrinsicType,
  Model,
  ModelProperty,
  Namespace,
  NumericLiteral,
  Operation,
  Program,
  Scalar,
  StringLiteral,
  Tuple,
  Type,
  Union,
  getDoc,
  getNamespaceFullName,
  getService,
  isErrorModel,
  isNeverType,
  isNullType,
  isVoidType,
} from "@typespec/compiler";
import {
  CodeTypeEmitter,
  Context,
  Declaration,
  EmitEntity,
  EmittedSourceFile,
  EmitterOutput,
  Placeholder,
  Scope,
  SourceFile,
  StringBuilder,
  TypeSpecDeclaration,
  code,
} from "@typespec/compiler/emitter-framework";
import {
  HttpOperation,
  HttpOperationParameter,
  HttpOperationResponse,
  MetadataInfo,
  Visibility,
  createMetadataInfo,
  getHttpOperation,
  isStatusCode,
} from "@typespec/http";
import { getResourceOperation } from "@typespec/rest";
import { exec } from "child_process";
import { getSerializationSourceFiles } from "./boilerplate.js";
import {
  CSharpSourceType,
  CSharpType,
  CSharpTypeMetadata,
  ControllerContext,
  LibrarySourceFile,
  NameCasingType,
} from "./interfaces.js";
import { CSharpServiceEmitterOptions, reportDiagnostic } from "./lib.js";
import { getRecordType } from "./type-helpers.js";
import {
  HttpMetadata,
  UnknownType,
  coalesceTypes,
  ensureCSharpIdentifier,
  ensureCleanDirectory,
  formatComment,
  getCSharpIdentifier,
  getCSharpStatusCode,
  getCSharpType,
  getCSharpTypeForScalar,
  getModelAttributes,
  getModelInstantiationName,
  getOperationVerbDecorator,
  isValueType,
} from "./utils.js";

export async function $onEmit(context: EmitContext<CSharpServiceEmitterOptions>) {
  let _unionCounter: number = 0;
  const controllers = new Map<string, ControllerContext>();
  const NoResourceContext: string = "RPCOperations";

  class CSharpCodeEmitter extends CodeTypeEmitter {
    #metadateMap: Map<Type, CSharpTypeMetadata> = new Map<Type, CSharpTypeMetadata>();
    #licenseHeader: string = `// Copyright (c) Microsoft Corporation. All rights reserved.
    // Licensed under the MIT License.`;
    #sourceTypeKey: string = "sourceType";
    #libraryFiles: LibrarySourceFile[] = getSerializationSourceFiles(this.emitter);
    #baseNamespace: string | undefined = undefined;

    #metaInfo: MetadataInfo = createMetadataInfo(this.emitter.getProgram(), {
      canonicalVisibility: Visibility.Read,
      canShareProperty: (p) => true,
    });

    arrayDeclaration(array: Model, name: string, elementType: Type): EmitterOutput<string> {
      return this.emitter.result.declaration(
        ensureCSharpIdentifier(this.emitter.getProgram(), array, name),
        code`${this.emitter.emitTypeReference(elementType)}[]`
      );
    }

    arrayLiteral(array: Model, elementType: Type): EmitterOutput<string> {
      return this.emitter.result.rawCode(code`${this.emitter.emitTypeReference(elementType)}[]`);
    }

    booleanLiteral(boolean: BooleanLiteral): EmitterOutput<string> {
      return this.emitter.result.rawCode(code`${boolean.value === true ? "true" : "false"}`);
    }

    unionLiteral(union: Union): EmitterOutput<string> {
      const csType = this.#coalesceUnionTypes(union);
      return this.emitter.result.rawCode(csType && csType.isBuiltIn ? csType.name : "object");
    }

    declarationName(declarationType: TypeSpecDeclaration): string {
      switch (declarationType.kind) {
        case "Enum":
        case "Interface":
        case "Model":
        case "Operation":
          return getCSharpIdentifier(declarationType.name, NameCasingType.Class);
        case "Union":
          if (!declarationType.name) return `Union${_unionCounter++}`;
          return getCSharpIdentifier(declarationType.name, NameCasingType.Class);
        case "Scalar":
        default:
          return getCSharpIdentifier(declarationType.name, NameCasingType.Variable);
      }
    }

    enumDeclaration(en: Enum, name: string): EmitterOutput<string> {
      const program = this.emitter.getProgram();
      const enumName = ensureCSharpIdentifier(program, en, name);
      const namespace = this.emitter.getContext().namespace;
      const doc = getDoc(this.emitter.getProgram(), en);
      const attributes = getModelAttributes(program, en, enumName);
      this.#metadateMap.set(en, new CSharpType({ name: enumName, namespace: namespace }));
      return this.emitter.result.declaration(
        enumName,
        code`${this.#licenseHeader}
        // <auto-generated />
        
        ${this.#emitUsings()}
        
        namespace ${namespace}
        {

            ${doc ? `${formatComment(doc)}` : ""}
            ${attributes.map((attribute) => attribute.getApplicationString(this.emitter.getContext().scope)).join("\n")}
            public enum ${enumName}
            {
              ${this.emitter.emitEnumMembers(en)};
            }
        } `
      );
    }

    enumDeclarationContext(en: Enum): Context {
      const enumName = ensureCSharpIdentifier(this.emitter.getProgram(), en, en.name);
      const enumFile = this.emitter.createSourceFile(`models/${enumName}.cs`);
      enumFile.meta[this.#sourceTypeKey] = CSharpSourceType.Model;
      const enumNamespace = `${this.#getOrSetBaseNamespace(en)}.Models`;
      return {
        namespace: enumNamespace,
        file: enumFile,
        scope: enumFile.globalScope,
      };
    }

    enumMembers(en: Enum): EmitterOutput<string> {
      const result = new StringBuilder();
      let i = 0;
      for (const [name, member] of en.members) {
        i++;
        const memberName: string = ensureCSharpIdentifier(this.emitter.getProgram(), member, name);
        this.#metadateMap.set(member, { name: memberName });
        result.push(
          code`${ensureCSharpIdentifier(this.emitter.getProgram(), member, name)} = "${
            member.value ? (member.value as string) : name
          }"`
        );
        if (i < en.members.size) result.pushLiteralSegment(", ");
      }

      return this.emitter.result.rawCode(result.reduce());
    }

    intrinsic(intrinsic: IntrinsicType, name: string): EmitterOutput<string> {
      switch (intrinsic.name) {
        case "unknown":
          return this.emitter.result.rawCode(code`JsonNode`);
        case "null":
          return this.emitter.result.rawCode(code`JsonNode`);
        case "ErrorType":
        case "never":
        case "void":
          reportDiagnostic(this.emitter.getProgram(), {
            code: "invalid-intrinsic",
            target: intrinsic,
            format: { typeName: intrinsic.name },
          });
          return "";
      }
    }

    #emitUsings(file?: SourceFile<string>): EmitterOutput<string> {
      const builder: StringBuilder = new StringBuilder();
      if (file === undefined) {
        file = this.emitter.getContext().file!;
      }
      for (const ns of [...file!.imports.keys()]) builder.pushLiteralSegment(`using ${ns};`);
      return builder.segments.join("\n");
    }

    modelDeclaration(model: Model, name: string): EmitterOutput<string> {
      const className = ensureCSharpIdentifier(this.emitter.getProgram(), model, name);
      const namespace = this.emitter.getContext().namespace;
      const doc = getDoc(this.emitter.getProgram(), model);
      const attributes = getModelAttributes(this.emitter.getProgram(), model, className);
      this.#metadateMap.set(model, new CSharpType({ name: className, namespace: namespace }));
      const decl = this.emitter.result.declaration(
        className,
        code`${this.#licenseHeader}
      // <auto-generated />

      ${this.#emitUsings()}
      
      namespace ${namespace} {

      ${doc ? `${formatComment(doc)}\n` : ""}${`${attributes.map((attribute) => attribute.getApplicationString(this.emitter.getContext().scope)).join("\n")}${attributes?.length > 0 ? "\n" : ""}`}public partial class ${className} ${
        model.baseModel ? code`: ${this.emitter.emitTypeReference(model.baseModel)}` : ""
      } {
      ${this.emitter.emitModelProperties(model)}
    }
   } `
      );

      return decl;
    }

    modelDeclarationContext(model: Model, name: string): Context {
      const modelName = ensureCSharpIdentifier(this.emitter.getProgram(), model, name);
      const modelFile = this.emitter.createSourceFile(`models/${modelName}.cs`);
      modelFile.meta[this.#sourceTypeKey] = CSharpSourceType.Model;
      const modelNamespace = `${this.#getOrSetBaseNamespace(model)}.Models`;
      return this.#createModelContext(modelNamespace, modelFile);
    }

    modelInstantiationContext(model: Model): Context {
      const modelName: string = getModelInstantiationName(
        this.emitter.getProgram(),
        model,
        model.name
      );
      const sourceFile = this.emitter.createSourceFile(`models/${modelName}.cs`);
      sourceFile.meta[this.#sourceTypeKey] = CSharpSourceType.Model;
      const modelNamespace = `${this.#getOrSetBaseNamespace(model)}.Models`;
      const context = this.#createModelContext(modelNamespace, sourceFile);
      context.instantiationName = modelName;
      return context;
    }

    modelInstantiation(model: Model, name: string): EmitterOutput<string> {
      const program = this.emitter.getProgram();
      const recordType = getRecordType(program, model);
      if (recordType !== undefined) {
        return code`Dictionary<string, ${this.emitter.emitTypeReference(recordType)}>`;
      }

      const context = this.emitter.getContext();
      const className = context.instantiationName ?? name;
      return this.modelDeclaration(model, className);
    }

    modelProperties(model: Model): EmitterOutput<string> {
      const result: StringBuilder = new StringBuilder();
      for (const [_, prop] of model.properties) {
        if (
          !isVoidType(prop.type) &&
          !isNeverType(prop.type) &&
          !isNullType(prop.type) &&
          !isErrorModel(this.emitter.getProgram(), prop.type)
        )
          result.push(code`${this.emitter.emitModelProperty(prop)}`);
      }

      return result.reduce();
    }

    #isRecord(type: Type): boolean {
      return type.kind === "Model" && type.name === "Record" && type.indexer !== undefined;
    }

    modelPropertyLiteral(property: ModelProperty): EmitterOutput<string> {
      if (isStatusCode(this.emitter.getProgram(), property)) return "";
      const propertyName = ensureCSharpIdentifier(
        this.emitter.getProgram(),
        property,
        property.name
      );
      const [typeName, typeDefault] = this.#findPropertyType(property);
      const doc = getDoc(this.emitter.getProgram(), property);
      const attributes = getModelAttributes(this.emitter.getProgram(), property);
      const defaultValue = property.default
        ? code`${this.emitter.emitType(property.default)}`
        : typeDefault;
      return this.emitter.result
        .rawCode(code`${doc ? `${formatComment(doc)}\n` : ""}${`${attributes.map((attribute) => attribute.getApplicationString(this.emitter.getContext().scope)).join("\n")}${attributes?.length > 0 ? "\n" : ""}`}public ${typeName}${
        property.optional && isValueType(this.emitter.getProgram(), property.type) ? "?" : ""
      } ${propertyName} { get; ${typeDefault ? "}" : "set; }"}${
        defaultValue ? ` = ${defaultValue};\n` : "\n"
      }
    `);
    }

    #findPropertyType(
      property: ModelProperty
    ): [EmitterOutput<string>, string | boolean | undefined] {
      switch (property.type.kind) {
        case "String":
          return [code`string`, `"${property.type.value}"`];
        case "Boolean":
          return [code`bool`, `${property.type.value === true ? true : false}`];
        case "Number":
        case "Object":
          return [code`object`, undefined];
        case "Model":
          if (this.#isRecord(property.type)) {
            return [code`JsonObject`, undefined];
          }
          return [code`${this.emitter.emitTypeReference(property.type)}`, undefined];
        default:
          return [code`${this.emitter.emitTypeReference(property.type)}`, undefined];
      }
    }

    modelPropertyReference(property: ModelProperty): EmitterOutput<string> {
      return code`${this.emitter.emitTypeReference(property.type)}`;
    }

    numericLiteral(number: NumericLiteral): EmitterOutput<string> {
      return this.emitter.result.rawCode(code`${number.value.toString()}`);
    }

    interfaceDeclaration(iface: Interface, name: string): EmitterOutput<string> {
      // interface declaration
      const ifaceName = `I${ensureCSharpIdentifier(
        this.emitter.getProgram(),
        iface,
        name,
        NameCasingType.Class
      )}`;
      const namespace = this.emitter.getContext().namespace;
      const doc = getDoc(this.emitter.getProgram(), iface);
      const attributes = getModelAttributes(this.emitter.getProgram(), iface, ifaceName);
      this.#metadateMap.set(iface, new CSharpType({ name: ifaceName, namespace: namespace }));
      const decl = this.emitter.result.declaration(
        ifaceName,
        code`${this.#licenseHeader}
      // <auto-generated />

      ${this.#emitUsings()}

      namespace ${namespace} {

      ${doc ? `${formatComment(doc)}\n` : ""}${`${attributes.map((attribute) => attribute.getApplicationString(this.emitter.getContext().scope)).join("\n")}${attributes?.length > 0 ? "\n" : ""}`}public interface ${ifaceName} {
      ${this.emitter.emitInterfaceOperations(iface)}
    }
   } `
      );

      return decl;
    }

    interfaceDeclarationContext(iface: Interface, name: string): Context {
      // set up interfaces file for declaration
      const ifaceName: string = `I${ensureCSharpIdentifier(this.emitter.getProgram(), iface, name, NameCasingType.Class)}`;
      const sourceFile = this.emitter.createSourceFile(`operations/${ifaceName}.cs`);
      sourceFile.meta[this.#sourceTypeKey] = CSharpSourceType.Interface;
      const ifaceNamespace = this.#getOrSetBaseNamespace(iface);
      const modelNamespace = `${ifaceNamespace}.Models`;
      const context = this.#createModelContext(ifaceNamespace, sourceFile);
      context.file.imports.set("System", ["System"]);
      context.file.imports.set("System.Net", ["System.Net"]);
      context.file.imports.set("System.Text.Json", ["System.Text.Json"]);
      context.file.imports.set("System.Text.Json.Serialization", [
        "System.Text.Json.Serialization",
      ]);
      context.file.imports.set("System.Threading.Tasks", ["System.Threading.Tasks"]);
      context.file.imports.set("Microsoft.AspNetCore.Mvc", ["Microsoft.AspNetCore.Mvc"]);
      context.file.imports.set(modelNamespace, [modelNamespace]);
      return context;
    }

    interfaceDeclarationOperations(iface: Interface): EmitterOutput<string> {
      // add in operations
      const builder: StringBuilder = new StringBuilder();
      const metadata = new HttpMetadata();
      const context = this.emitter.getContext();
      for (const [name, operation] of iface.operations) {
        const doc = getDoc(this.emitter.getProgram(), operation);
        const returnTypes: Type[] = [];
        const [httpOp, _] = getHttpOperation(this.emitter.getProgram(), operation);
        for (const response of httpOp.responses.filter(
          (r) => !isErrorModel(this.emitter.getProgram(), r.type)
        )) {
          returnTypes.push(
            metadata.resolveLogicalResponseType(this.emitter.getProgram(), response)
          );
        }
        const returnInfo = coalesceTypes(this.emitter.getProgram(), returnTypes, context.namespace);
        const returnType: CSharpType = returnInfo?.type || UnknownType;
        const opName = ensureCSharpIdentifier(
          this.emitter.getProgram(),
          operation,
          name,
          NameCasingType.Method
        );
        const opDecl = this.emitter.result.declaration(
          opName,
          code`${doc ? `${formatComment(doc)}\n` : ""}${returnType.name === "void" ? "Task" : `Task<${returnType.getTypeReference(context.scope)}>`} ${opName}Async( ${this.#emitInterfaceOperationParameters(operation, opName, "")});`
        );
        builder.push(code`${opDecl.value}\n`);
        this.emitter.emitInterfaceOperation(operation);
      }
      return builder.reduce();
    }

    interfaceOperationDeclarationContext(operation: Operation): Context {
      const resource = getResourceOperation(this.emitter.getProgram(), operation);
      const controllerName: string =
        operation.interface !== undefined
          ? operation.interface.name
          : resource === undefined
            ? NoResourceContext
            : resource.resourceType.name;
      return this.#createOrGetResourceContext(controllerName, operation, resource?.resourceType);
    }

    interfaceOperationDeclaration(operation: Operation, name: string): EmitterOutput<string> {
      const operationName = ensureCSharpIdentifier(
        this.emitter.getProgram(),
        operation,
        name,
        NameCasingType.Method
      );
      const doc = getDoc(this.emitter.getProgram(), operation);
      const [httpOperation, _] = getHttpOperation(this.emitter.getProgram(), operation);
      const declParams = this.#emitHttpOperationParameters(httpOperation);
      return this.emitter.result.declaration(
        operation.name,
        code`
        ${doc ? `${formatComment(doc)}` : ""}
        [${getOperationVerbDecorator(httpOperation)}]
        [Route("${httpOperation.path}")]
        ${this.emitter.emitOperationReturnType(operation)}
        public virtual async Task<IActionResult> ${operationName}(${declParams})
        {
          ${
            httpOperation.verb !== "delete"
              ? `var result = await ${this.emitter.getContext().resourceName}Impl.${operationName}Async(${this.#emitOperationCallParameters(
                  httpOperation
                )});
          return Ok(result);`
              : `await ${this.emitter.getContext().resourceName}Impl.${operationName}Async(${this.#emitOperationCallParameters(
                  httpOperation
                )});
          return NoContent();`
          }
        }`
      );
    }

    operationDeclarationContext(operation: Operation, name: string): Context {
      const resource = getResourceOperation(this.emitter.getProgram(), operation);
      const controllerName: string =
        operation.interface?.name ?? resource === undefined
          ? NoResourceContext
          : resource.resourceType.name;
      return this.#createOrGetResourceContext(controllerName, operation, resource?.resourceType);
    }

    operationDeclaration(operation: Operation, name: string): EmitterOutput<string> {
      const operationName = ensureCSharpIdentifier(
        this.emitter.getProgram(),
        operation,
        name,
        NameCasingType.Method
      );
      const doc = getDoc(this.emitter.getProgram(), operation);
      const [httpOperation, _] = getHttpOperation(this.emitter.getProgram(), operation);
      const declParams = this.#emitHttpOperationParameters(httpOperation);
      return this.emitter.result.declaration(
        operation.name,
        code`
        ${doc ? `${formatComment(doc)}` : ""}
        [${getOperationVerbDecorator(httpOperation)}]
        [Route("${httpOperation.path}")]
        ${this.emitter.emitOperationReturnType(operation)}
        public virtual async Task<IActionResult> ${operationName}(${declParams})
        {
          ${
            httpOperation.verb !== "delete"
              ? `var result = await ${this.emitter.getContext().resourceName}Impl.${operationName}Async(${this.#emitOperationCallParameters(
                  httpOperation
                )});
          return Ok(result);`
              : `await ${this.emitter.getContext().resourceName}Impl.${operationName}Async(${this.#emitOperationCallParameters(
                  httpOperation
                )});
          return NoContent();`
          }
        }`
      );
    }
    operationReturnType(operation: Operation, returnType: Type): EmitterOutput<string> {
      const [httpOperation, _] = getHttpOperation(this.emitter.getProgram(), operation);
      return this.#emitOperationResponses(httpOperation);
    }

    #emitOperationResponses(operation: HttpOperation): EmitterOutput<string> {
      const builder: StringBuilder = new StringBuilder();
      let i = 0;
      const validResponses = operation.responses.filter(
        (r) =>
          !isErrorModel(this.emitter.getProgram(), r.type) &&
          getCSharpStatusCode(r.statusCodes) !== undefined
      );
      for (const response of validResponses) {
        i++;
        builder.push(code`${this.#emitOperationResponseDecorator(response)}`);
        if (i < validResponses.length) {
          builder.pushLiteralSegment("\n");
        }
      }

      for (const response of operation.responses) {
        this.emitter.emitType(response.type);
      }

      return builder.reduce();
    }

    #emitOperationResponseDecorator(response: HttpOperationResponse) {
      const responseType = new HttpMetadata().resolveLogicalResponseType(
        this.emitter.getProgram(),
        response
      );
      return this.emitter.result.rawCode(
        code`[ProducesResponseType((int)${getCSharpStatusCode(
          response.statusCodes
        )!}, Type = typeof(${this.#emitResponseType(responseType)}))]`
      );
    }

    #emitResponseType(type: Type) {
      const context = this.emitter.getContext();
      const result = getCSharpType(this.emitter.getProgram(), type, context.namespace);
      const resultType = result?.type || UnknownType;
      return resultType.getTypeReference(context.scope);
    }

    #emitInterfaceOperationParameters(
      operation: Operation,
      operationName: string,
      resourceName: string
    ): EmitterOutput<string> {
      const signature = new StringBuilder();
      const requiredParams: ModelProperty[] = [];
      const optionalParams: ModelProperty[] = [];
      let totalParams = 0;
      for (const [_, parameter] of operation.parameters.properties) {
        if (parameter.optional) optionalParams.push(parameter);
        else requiredParams.push(parameter);
        totalParams++;
      }
      let i = 1;
      for (const requiredParam of requiredParams) {
        signature.push(
          code`${this.emitter.emitTypeReference(requiredParam.type)} ${ensureCSharpIdentifier(this.emitter.getProgram(), requiredParam, requiredParam.name, NameCasingType.Parameter)}${i++ < totalParams ? ", " : ""}`
        );
      }
      for (const optionalParam of optionalParams) {
        signature.push(
          code`${this.emitter.emitTypeReference(optionalParam.type)}? ${ensureCSharpIdentifier(this.emitter.getProgram(), optionalParam, optionalParam.name, NameCasingType.Parameter)}${i++ < totalParams ? ", " : ""}`
        );
      }
      return signature.reduce();
    }

    #emitHttpOperationParameters(operation: HttpOperation): EmitterOutput<string> {
      const signature = new StringBuilder();
      const bodyParam = operation.parameters.body;
      let i = 0;
      //const pathParameters = operation.parameters.parameters.filter((p) => p.type === "path");
      for (const parameter of operation.parameters.parameters) {
        i++;
        if (parameter.param.type.kind !== "Intrinsic" || parameter.param.type.name !== "never") {
          signature.push(
            code`${this.#emitOperationSignatureParameter(operation, parameter)}${
              i < operation.parameters.parameters.length || bodyParam !== undefined ? ", " : ""
            }`
          );
        }
      }
      if (bodyParam !== undefined) {
        signature.push(
          code`${this.emitter.emitTypeReference(
            this.#metaInfo.getEffectivePayloadType(
              bodyParam.type,
              Visibility.Create & Visibility.Update
            )
          )} body`
        );
      }

      return signature.reduce();
    }

    unionDeclaration(union: Union, name: string): EmitterOutput<string> {
      const baseType = this.#coalesceUnionTypes(union);
      if (baseType.isBuiltIn && baseType.name === "string") {
        const program = this.emitter.getProgram();
        const unionName = ensureCSharpIdentifier(program, union, name);
        const namespace = this.emitter.getContext().namespace;
        const doc = getDoc(this.emitter.getProgram(), union);
        const attributes = getModelAttributes(program, union, unionName);
        this.#metadateMap.set(union, new CSharpType({ name: unionName, namespace: namespace }));
        return this.emitter.result.declaration(
          unionName,
          code`${this.#licenseHeader}
        // <auto-generated />
        
        ${this.#emitUsings()}
        
        namespace ${namespace}
        {

            ${doc ? `${formatComment(doc)}` : ""}
            ${attributes.map((attribute) => attribute.getApplicationString(this.emitter.getContext().scope)).join("\n")}
            public enum ${unionName}
            {
              ${this.emitter.emitUnionVariants(union)};
            }
        } `
        );
      }

      return this.emitter.result.rawCode(code`${baseType.getTypeReference()}`);
    }

    unionDeclarationContext(union: Union): Context {
      const baseType = this.#coalesceUnionTypes(union);
      if (baseType.isBuiltIn && baseType.name === "string") {
        const unionName = ensureCSharpIdentifier(
          this.emitter.getProgram(),
          union,
          union.name || "Union"
        );
        const unionFile = this.emitter.createSourceFile(`models/${unionName}.cs`);
        unionFile.meta[this.#sourceTypeKey] = CSharpSourceType.Model;
        const unionNamespace = `${this.#getOrSetBaseNamespace(union)}.Models`;
        return {
          namespace: unionNamespace,
          file: unionFile,
          scope: unionFile.globalScope,
        };
      } else {
        return this.emitter.getContext();
      }
    }

    unionInstantiation(union: Union, name: string): EmitterOutput<string> {
      return super.unionInstantiation(union, name);
    }

    unionInstantiationContext(union: Union, name: string): Context {
      return super.unionInstantiationContext(union, name);
    }

    unionVariants(union: Union): EmitterOutput<string> {
      const result = new StringBuilder();
      let i = 0;
      for (const [name, variant] of union.variants) {
        i++;
        if (variant.type.kind === "String") {
          const nameHint: string = (name as string) || variant.type.value;
          const memberName: string = ensureCSharpIdentifier(
            this.emitter.getProgram(),
            variant,
            nameHint
          );
          this.#metadateMap.set(variant, { name: memberName });
          result.push(
            code`${ensureCSharpIdentifier(this.emitter.getProgram(), variant, nameHint)} = "${variant.type.value}"`
          );
          if (i < union.variants.size) result.pushLiteralSegment(", ");
        }
      }

      return this.emitter.result.rawCode(result.reduce());
    }

    unionVariantContext(union: Union): Context {
      return super.unionVariantContext(union);
    }

    #emitOperationSignatureParameter(
      operation: HttpOperation,
      httpParam: HttpOperationParameter
    ): EmitterOutput<string> {
      const name = httpParam.param.name;
      const parameter = httpParam.param;
      const emittedName = ensureCSharpIdentifier(
        this.emitter.getProgram(),
        parameter,
        name,
        NameCasingType.Parameter
      );
      const [emittedType, emittedDefault] = this.#findPropertyType(parameter);
      const defaultValue = parameter.default
        ? code`${this.emitter.emitType(parameter.default)}`
        : emittedDefault;
      return this.emitter.result.rawCode(
        code`${httpParam.type !== "path" ? this.#emitParameterAttribute(httpParam) : ""}${emittedType} ${emittedName}${defaultValue === undefined ? "" : ` = ${defaultValue}`}`
      );
    }

    #emitOperationCallParameters(operation: HttpOperation): EmitterOutput<string> {
      const signature = new StringBuilder();
      const bodyParam = operation.parameters.body;
      let i = 0;
      //const pathParameters = operation.parameters.parameters.filter((p) => p.type === "path");
      for (const parameter of operation.parameters.parameters) {
        i++;
        if (
          !isNeverType(parameter.param.type) &&
          !isNullType(parameter.param.type) &&
          !isVoidType(parameter.param.type)
        ) {
          signature.push(
            code`${this.#emitOperationCallParameter(operation, parameter)}${
              i < operation.parameters.parameters.length || bodyParam !== undefined ? ", " : ""
            }`
          );
        }
      }
      if (bodyParam !== undefined) {
        signature.push(code`body`);
      }

      return signature.reduce();
    }
    #emitOperationCallParameter(
      operation: HttpOperation,
      httpParam: HttpOperationParameter
    ): EmitterOutput<string> {
      const name = httpParam.param.name;
      const parameter = httpParam.param;
      const emittedName = ensureCSharpIdentifier(
        this.emitter.getProgram(),
        parameter,
        name,
        NameCasingType.Parameter
      );
      return this.emitter.result.rawCode(code`${emittedName}`);
    }

    #emitParameterAttribute(parameter: HttpOperationParameter): EmitterOutput<string> {
      switch (parameter.type) {
        case "header":
          return code`[FromHeader(Name="${parameter.name}")] `;
        case "query":
          return code`[FromQuery(Name="${parameter.name}")] `;
        default:
          return "";
      }
    }

    #createModelContext(namespace: string, file: SourceFile<string>): Context {
      const context = {
        namespace: namespace,
        file: file,
        scope: file.globalScope,
      };
      context.file.imports.set("System", ["System"]);
      context.file.imports.set("System.Text.Json", ["System.Text.Json"]);
      context.file.imports.set("System.Text.Json.Serialization", [
        "System.Text.Json.Serialization",
      ]);
      return context;
    }

    #createOrGetResourceContext(
      name: string,
      operation: Operation,
      resource?: Model
    ): ControllerContext {
      let context: ControllerContext | undefined = controllers.get(name);
      if (context !== undefined) return context;
      const sourceFile: SourceFile<string> = this.emitter.createSourceFile(
        `controllers/${name}ControllerBase.cs`
      );
      const namespace = this.#getOrSetBaseNamespace(operation);
      const modelNamespace = `${namespace}.Models`;
      sourceFile.meta[this.#sourceTypeKey] = CSharpSourceType.Controller;
      sourceFile.meta["resourceName"] = name;
      sourceFile.meta["resource"] = `${name}Controller`;
      sourceFile.meta["namespace"] = namespace;
      context = {
        namespace: sourceFile.meta["namespace"],
        file: sourceFile,
        resourceName: name,
        scope: sourceFile.globalScope,
        resourceType: resource,
      };
      context.file.imports.set("System", ["System"]);
      context.file.imports.set("System.Net", ["System.Net"]);
      context.file.imports.set("System.Threading.Tasks", ["System.Threading.Tasks"]);
      context.file.imports.set("System.Text.Json", ["System.Text.Json"]);
      context.file.imports.set("System.Text.Json.Serialization", [
        "System.Text.Json.Serialization",
      ]);
      context.file.imports.set("Microsoft.AspNetCore.Mvc", ["Microsoft.AspNetCore.Mvc"]);
      context.file.imports.set(modelNamespace, [modelNamespace]);
      context.file.imports.set(namespace, [namespace]);
      controllers.set(name, context);
      return context;
    }

    #getNamespaceFullName(namespace: Namespace | undefined): string {
      return namespace
        ? ensureCSharpIdentifier(
            this.emitter.getProgram(),
            namespace,
            getNamespaceFullName(namespace)
          )
        : "TypeSpec";
    }
    reference(
      targetDeclaration: Declaration<string>,
      pathUp: Scope<string>[],
      pathDown: Scope<string>[],
      commonScope: Scope<string> | null
    ): string | EmitEntity<string> {
      //if (targetDeclaration.name) return targetDeclaration.name;
      return super.reference(targetDeclaration, pathUp, pathDown, commonScope);
    }

    scalarInstantiation(scalar: Scalar, name: string | undefined): EmitterOutput<string> {
      const scalarType = getCSharpTypeForScalar(this.emitter.getProgram(), scalar);
      return scalarType.getTypeReference(this.emitter.getContext().scope);
    }

    scalarDeclaration(scalar: Scalar, name: string): EmitterOutput<string> {
      const foo: Placeholder<string> = new Placeholder<string>();
      foo.setValue;
      const scalarType = getCSharpTypeForScalar(this.emitter.getProgram(), scalar);
      return scalarType.getTypeReference(this.emitter.getContext().scope);
    }

    sourceFile(sourceFile: SourceFile<string>): EmittedSourceFile {
      for (const libFile of this.#libraryFiles) {
        if (sourceFile === libFile.source) return libFile.emitted;
      }

      const emittedSourceFile: EmittedSourceFile = {
        path: sourceFile.path,
        contents: "",
      };

      switch (sourceFile.meta[this.#sourceTypeKey]) {
        case CSharpSourceType.Controller:
          emittedSourceFile.contents = this.#emitControllerContents(sourceFile);
          break;
        default:
          emittedSourceFile.contents = this.#emitCodeContents(sourceFile);
          break;
      }

      return emittedSourceFile;
    }

    #emitCodeContents(file: SourceFile<string>): string {
      const contents: StringBuilder = new StringBuilder();
      for (const decl of file.globalScope.declarations) {
        contents.push(decl.value);
      }

      return contents.segments.join("\n") + "\n";
    }

    #emitControllerContents(file: SourceFile<string>): string {
      const namespace = file.meta.namespace;
      const contents: StringBuilder = new StringBuilder();
      contents.push(`${this.#licenseHeader}\n`);
      contents.push("// <auto-generated />\n\n");
      contents.push(code`${this.#emitUsings(file)}\n`);
      contents.push("\n");
      contents.push(`namespace ${namespace}.Controllers\n`);
      contents.push("{\n");
      contents.push("[ApiController]\n");
      contents.push(`public abstract partial class ${file.meta["resource"]}Base: ControllerBase\n`);
      contents.push("{\n");
      contents.push("\n");
      contents.push(
        code`internal abstract I${file.meta.resourceName} ${file.meta.resourceName}Impl { get;}\n`
      );
      for (const decl of file.globalScope.declarations) {
        contents.push(decl.value + "\n");
      }
      contents.push("\n}");
      contents.push("\n}");

      return contents.segments.join("\n") + "\n";
    }

    stringLiteral(string: StringLiteral): EmitterOutput<string> {
      return this.emitter.result.rawCode(code`"${string.value}"`);
    }

    tupleLiteral(tuple: Tuple): EmitterOutput<string> {
      return this.emitter.result.rawCode(code`{
        ${this.emitter.emitTupleLiteralValues(tuple)}
      }`);
    }

    tupleLiteralValues(tuple: Tuple): EmitterOutput<string> {
      const result = new StringBuilder();
      for (const tupleValue of tuple.values) {
        result.push(code`${this.emitter.emitType(tupleValue)}`);
      }
      return this.emitter.result.rawCode(result.segments.join(",\n"));
    }

    createModelScope(baseScope: Scope<string>, namespace: string): Scope<string> {
      let current: Scope<string> = baseScope;
      for (const part of namespace.split(".")) {
        current = this.emitter.createScope({}, getCSharpIdentifier(part), current);
      }
      return current;
    }

    #getTemplateParameters(model: Model): EmitterOutput<string> {
      if (!model.templateMapper) return "";
      let i = 0;
      const params = new StringBuilder();
      const args = model.templateMapper.args.filter(
        (parameter) =>
          parameter.kind !== "Boolean" &&
          parameter.kind !== "Intrinsic" &&
          parameter.kind !== "Number" &&
          parameter.kind !== "String" &&
          parameter.kind !== "Tuple"
      );
      for (const parameter of args) {
        i++;
        params.push(code`${this.emitter.emitTypeReference(parameter)}`);
        if (i < args.length) {
          params.pushLiteralSegment(",");
        }
      }
      if (params.segments.length > 0) return params.reduce();
      return "";
    }

    #coalesceUnionTypes(union: Union): CSharpType {
      const defaultValue: CSharpType = new CSharpType({
        name: "object",
        namespace: "System",
        isValueType: false,
      });
      let current: CSharpType | undefined = undefined;
      for (const [_, variant] of union.variants.entries()) {
        let candidate: CSharpType;
        switch (variant.type.kind) {
          case "Boolean":
            candidate = new CSharpType({ name: "bool", namespace: "System", isValueType: true });
            break;
          case "String":
            candidate = new CSharpType({ name: "string", namespace: "System", isValueType: false });
            break;
          case "Union":
            candidate = this.#coalesceUnionTypes(variant.type);
            break;
          case "Scalar":
            candidate = getCSharpTypeForScalar(this.emitter.getProgram(), variant.type);
            break;
          default:
            return defaultValue;
        }

        current = current ?? candidate;
        if (current === undefined || !candidate.equals(current)) return defaultValue;
      }
      return current ?? defaultValue;
    }

    writeOutput(sourceFiles: SourceFile<string>[]): Promise<void> {
      for (const source of this.#libraryFiles) {
        sourceFiles.push(source.source);
      }
      return super.writeOutput(sourceFiles);
    }

    #getOrSetBaseNamespace(type: Type & { namespace?: Namespace }): string {
      if (this.#baseNamespace === undefined) {
        if (type.namespace !== undefined) {
          this.#baseNamespace = `${
            type.namespace
              ? ensureCSharpIdentifier(
                  this.emitter.getProgram(),
                  type.namespace,
                  getNamespaceFullName(type.namespace)
                )
              : "TypeSpec"
          }.Service`;
        } else {
          this.#baseNamespace = "TypeSpec.Service";
        }
      }
      return this.#baseNamespace;
    }
  }

  function processNameSpace(program: Program, target: Namespace) {
    const service = getService(program, target);
    if (service) {
      for (const [_, model] of target.models) {
        emitter.emitType(model);
      }
      for (const [_, en] of target.enums) {
        emitter.emitType(en);
      }
      for (const [_, sc] of target.scalars) {
        emitter.emitType(sc);
      }
      for (const [_, iface] of target.interfaces) {
        emitter.emitType(iface);
      }
      for (const [_, op] of target.operations) {
        emitter.emitType(op);
      }
    } else {
      for (const [_, sub] of target.namespaces) {
        processNameSpace(program, sub);
      }
    }
  }

  const emitter = context.getAssetEmitter(CSharpCodeEmitter);
  const ns = context.program.checker.getGlobalNamespaceType();
  const options = emitter.getOptions();
  processNameSpace(context.program, ns);

  await ensureCleanDirectory(context.program, options.emitterOutputDir);
  await emitter.writeOutput();
  if (options["skip-format"] === undefined || options["skip-format"] === false) {
    await exec(
      `dotnet format whitespace ${
        emitter.getOptions().emitterOutputDir
      } --include-generated --folder`
    );
  }
}
