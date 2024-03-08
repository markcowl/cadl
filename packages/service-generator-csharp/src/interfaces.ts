import { Model } from "@typespec/compiler";
import { Context, Scope, SourceFile, StringBuilder } from "@typespec/compiler/emitter-framework";

export const HelperNamespace: string = "Microsoft.TypeSpec.Service.Models";

export interface CSharpTypeMetadata {
  name: string;
  namespace?: string;
}

export class CSharpType implements CSharpTypeMetadata {
  name: string;
  namespace: string;
  isBuiltIn: boolean;
  isValueType: boolean;

  public constructor(input: {
    name: string;
    namespace: string;
    isBuiltIn?: boolean;
    isValueType?: boolean;
  }) {
    this.name = input.name;
    this.namespace = input.namespace;
    this.isBuiltIn = input.isBuiltIn !== undefined ? input.isBuiltIn : input.namespace === "System";
    this.isValueType = input.isValueType !== undefined ? input.isValueType : false;
  }

  isNamespaceInScope(scope?: Scope<string>, visited?: Set<Scope<string>>): boolean {
    if (this.isBuiltIn) return true;
    if (scope === undefined) return false;
    if (!visited) visited = new Set<Scope<string>>();
    if (visited.has(scope)) return false;
    visited.add(scope);

    switch (scope.kind) {
      case "namespace": {
        if (scope.namespace.startsWith(this.namespace)) return true;
        return this.isNamespaceInScope(scope.parentScope, visited);
      }

      case "sourceFile": {
        for (const entry of scope.sourceFile.imports.keys()) {
          if (entry === this.namespace) {
            return true;
          }
        }
        return this.isNamespaceInScope(scope.sourceFile.globalScope, visited);
      }
      default:
        return false;
    }
  }
  public getTypeReference(scope?: Scope<string>): string {
    return `${this.isNamespaceInScope(scope) ? "" : this.namespace + "."}${this.name}`;
  }

  public equals(other: CSharpType | undefined): boolean {
    return this.name === other?.name && this.namespace === other?.namespace;
  }
}

export abstract class CSharpValue {
  value?: any;
  public abstract emitValue(scope?: Scope<string>): string;
}

export class StringValue extends CSharpValue {
  value?: string;
  public constructor(value?: string) {
    super();
    this.value = value;
  }
  public emitValue(scope?: Scope<string> | undefined): string {
    return `"${this.value}"`;
  }
}

export class NumericValue extends CSharpValue {
  value?: number;
  public constructor(value?: number) {
    super();
    this.value = value;
  }
  public emitValue(scope?: Scope<string> | undefined): string {
    return `${this.value}` ?? "0";
  }
}

export class Parameter implements CSharpTypeMetadata {
  type: CSharpType;
  optional: boolean;
  name: string;
  value?: CSharpValue;
  defaultValue?: CSharpValue;

  constructor(input: {
    name: string;
    type: CSharpType;
    optional: boolean;
    value?: CSharpValue;
    defaultValue?: CSharpValue;
  }) {
    this.name = input.name;
    this.type = input.type;
    this.optional = input.optional;
    this.value = input.value;
    this.defaultValue = input.defaultValue;
  }

  public getDeclarationString(scope?: Scope<string>): string {
    const sb: string[] = [];
    sb.push(`${this.type.getTypeReference(scope)}`);
    if (this.optional) sb.push("?");
    sb.push(` ${this.name}`);
    if (this.defaultValue !== undefined) sb.push(` = ${this.defaultValue.emitValue(scope)}`);
    return sb.join(", ");
  }

  public getCallString(scope?: Scope<string>): string {
    if (!this.value) return "";
    const sb: string[] = [];
    if (this.optional) sb.push(`${this.name} = `);
    sb.push(this.value.emitValue(scope));
    return sb.join(", ");
  }
}

export class AttributeType extends CSharpType {
  public getTypeReference(scope?: Scope<string> | undefined): string {
    const ref = super.getTypeReference(scope);
    const suffixStart = ref.lastIndexOf("Attribute");
    if (suffixStart < 1) return ref;
    return ref.slice(0, suffixStart);
  }
}

export class Attribute {
  type: AttributeType;
  parameters: Parameter[];

  constructor(type: AttributeType, parameters?: Parameter[]) {
    this.type = type;
    this.parameters = parameters === undefined ? [] : parameters;
  }

  public getApplicationString(scope?: Scope<string>): string {
    const sb: string[] = [];
    const parameters: string[] = [];
    sb.push(`[${this.type.getTypeReference(scope)}`);
    for (let i = 0; i < this.parameters.length; ++i) {
      parameters.push(this.parameters[i].getCallString(scope));
    }
    if (parameters.length > 0) sb.push(`( ${parameters.join(", ")})`);
    sb.push("]");
    return sb.join("");
  }
}

export abstract class CSharpDeclaration {
  type?: CSharpType;
  public abstract getDeclaration(scope: Scope<string>): string | StringBuilder;
}

export class CSharpModel extends CSharpDeclaration {
  public getDeclaration(scope: Scope<string>): string | StringBuilder {
    return "";
  }
}

export class CSharpEnum extends CSharpDeclaration {
  public getDeclaration(scope: Scope<string>): string | StringBuilder {
    return "";
  }
}

export class CSharpController extends CSharpDeclaration {
  public getDeclaration(scope: Scope<string>): string | StringBuilder {
    return "";
  }
}
export interface ControllerContext extends Context {
  file: SourceFile<string>;
  resourceName: string;
  resourceType?: Model;
  scope: Scope<string>;
}

export enum CSharpSourceType {
  Model,
  Controller,
  RouteConstants,
  OperationState,
  OperationStatus,
  ResourceOperationStatus,
}

export enum NameCasingType {
  Class,
  Constant,
  Method,
  Namespace,
  Parameter,
  Property,
  Variable,
}
