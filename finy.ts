

function register(name: string, thing: any) {
  (window as any).finy ??= {};
  (window as any).finy[name] = thing;
}


/// Logging utilities
let logEnabled = true;
register('enableLogging',  () => logEnabled = true);
register('disableLogging', () => logEnabled = false);
function logInfo (...args: any[]) { logEnabled && console.info (...args); }
function logWarn (...args: any[]) { logEnabled && console.warn (...args); }
function logError(...args: any[]) { logEnabled && console.error(...args); }


/// Utilities
register('range', function*(start: number, end?: number): Generator<number> {
  [start, end] = end == null ? [0, start] : [start, end];
  if (start < end) {
    for (let i = start; i < end; yield i++);
  } else {
    for (let i = start; i > end; yield i--);
  }
});


/// Helpers
function evalWithContext<T>(code: string, context: Record<string, any>): T {
  return new Function(
    ...Object.keys(context),
    `"use strict"; return (${code});`
  )(...Object.values(context));
}

function getForBindings(expression: string): Set<string> {
  const bindings = new Set<string>();
  const trimmed = expression.trimStart();

  const ident = trimmed.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)?.[0];
  if (ident) {
    bindings.add(ident);
    return bindings;
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const o = trimmed[0];
    const c = o === '[' ? ']' : '}';

    let index = 1;
    let level = 1;
    for (; index < trimmed.length && level > 0; index++) {
      switch (trimmed[index]) {
        case o: level++; break;
        case c: level--; break;
      }
    }

    if (level !== 0)
      throw new Error(`Mismatched ${o === '[' ? 'brackets' : 'braces'} in expression "${expression}".`);

    const pattern = trimmed.slice(1, index - 1);
    for (const match of pattern.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$]*/g))
      bindings.add(match[0]);
    return bindings;
  }

  throw new Error('Unknown syntax for f-for expression.');
}


/// Core component system
const componentNames = new Set<string>(); // for quick lookup of component names when parsing templates
const components = new Map<string, typeof Component>();
type BindingContext = Record<string, any>;
type AttributeValues = Map<string, string>;
type SlotContent = Map<string, FinyNode[]>;
type RenderState = {
  slots: SlotContent;
  parentArgs: BindingContext;
};
type NativeShell = {
  element: Element;
  dynamicAttrs: AttributeValues;
};
type SlotArg = { name: string, value: string };

const emptyState: RenderState = { slots: new Map(), parentArgs: {} };

function isTemplateElement(element: Element): element is HTMLTemplateElement {
  return element.tagName.toLowerCase() === 'template' && 'content' in element;
}

function childNodesOf(node: Node): Iterable<Node> {
  if (node instanceof Element && isTemplateElement(node))
    return node.content.childNodes;
  return node.childNodes;
}

function appendNodes(parent: Node, nodes: Node[]) {
  for (const node of nodes)
    parent.appendChild(node);
}

function renderNodes(nodes: FinyNode[], args: BindingContext, state: RenderState = emptyState): Node[] {
  return nodes.flatMap(node => node.render(args, state));
}

function copySlots(slots: SlotContent): SlotContent {
  return new Map(Array.from(slots, ([name, nodes]) => [name, [...nodes]]));
}

function isSpecialAttr(name: string): boolean {
  return [
    'f-if',
    'f-elif',
    'f-else',
    'f-for',
    'f-component',
    'f-slot',
  ].includes(name) || name.startsWith('f-arg:');
}

function makeNativeShell(element: Element, omitted: Set<string> = new Set()): NativeShell {
  const clone = element.cloneNode(false) as Element;
  const dynamicAttrs: AttributeValues = new Map();

  for (const attr of Array.from(clone.attributes)) {
    if (omitted.has(attr.name) || isSpecialAttr(attr.name)) {
      clone.removeAttribute(attr.name);
      continue;
    }

    if (attr.name.startsWith('$')) {
      clone.removeAttribute(attr.name);
      dynamicAttrs.set(attr.name.slice(1), attr.value);
    }
  }

  return { element: clone, dynamicAttrs };
}

function renderNativeShell(shell: NativeShell, args: BindingContext, children: Node[]): Element {
  const clone = shell.element.cloneNode(false) as Element;
  for (const [name, value] of shell.dynamicAttrs)
    clone.setAttribute(name, String(evalWithContext<any>(value, args)));
  appendNodes(clone, children);
  return clone;
}

function collectComponentAttributes(element: Element, omitted: Set<string> = new Set()): AttributeValues {
  const attributes: AttributeValues = new Map();
  for (const attr of Array.from(element.attributes))
    if (!omitted.has(attr.name) && !isSpecialAttr(attr.name))
      attributes.set(attr.name, attr.value);
  return attributes;
}

function resolveAttributeValue(value: string, context: BindingContext): any {
  if (Object.keys(context).length === 0)
    return value;

  try {
    return evalWithContext<any>(value, context);
  } catch {
    return value;
  }
}

abstract class Component {
  static arguments: Map<string, Argument> = new Map();
  static contents: FinyNode[] = [];

  static render(root: Element, args: BindingContext = {}) {
    const nodes = renderNodes(FinyNode.fromNodes([root], true), args, { slots: new Map(), parentArgs: args });
    return this.replaceWithNodes(root, nodes);
  }

  static expand(attributes: AttributeValues, slots: SlotContent, parentArgs: BindingContext): Node[] {
    const args: BindingContext = {};
    for (const [name, arg] of this.arguments) {
      const attr = attributes.get(name);
      if (attr !== undefined) {
        args[name] = arg.construct(resolveAttributeValue(attr, parentArgs));
        continue;
      }

      if (!arg.optional)
        throw new Error(`Missing required argument "${name}" for component "${this.name}".`);

      args[name] = arg.defaultValue;
    }

    return renderNodes(this.contents, args, {
      slots: copySlots(slots),
      parentArgs,
    });
  }

  static apply(element: Element, parentArgs: BindingContext = {}): boolean {
    const attributes = collectComponentAttributes(element);
    const slots = collectSlotContent(element);
    const nodes = this.expand(attributes, slots, parentArgs);
    return this.replaceWithNodes(element, nodes);
  }

  private static replaceWithNodes(root: Element, nodes: Node[]): boolean {
    const parent = root.parentNode;
    if (parent) {
      for (const node of nodes)
        parent.insertBefore(node, root);
      root.remove();
      return true;
    }

    throw new Error('Unable to render on root-less element.');
  }

  static registerAll() {
    const templates = document.querySelectorAll('template[finy]');

    for (const template of templates)
      componentNames.add(template.id);

    for (const template of templates) {
      try {
        const component = this.fromTemplate(template as HTMLTemplateElement);
        components.set(template.id, component);

        let message = `Registered component "${template.id}" with `;

        if (component.arguments.size === 0) {
          message += 'no arguments.';
        } else {
          message += 'arguments:';
          for (const arg of component.arguments.values())
            message += `\n  - ${arg.name}: ${arg.typeStr}${arg.optional ? '?' : ''} (default: ${arg.defaultValue})`;
        }

        logInfo(message);
        logInfo(`Component "${template.id}" contents:`, component.contents);

      } catch (error) {
        logError(`Error registering component from template with id "${template.id}":`, error);
      }
    }
  }

  private static fromTemplate(template: HTMLTemplateElement): typeof Component {
    if (!/^[a-z][a-z0-9_-]*$/.test(template.id))
      throw new Error(`Invalid component id "${template.id}". Must be kebab-case.`);

    template.remove();

    const args = new Map<string, Argument>();
    for (const attr of Array.from(template.attributes)) {
      if (['finy', 'id'].includes(attr.name))
        continue;

      const arg = Argument.fromAttribute(attr);
      if (args.has(arg.name))
        throw new Error(`Duplicate argument name "${arg.name}" in component "${template.id}".`);
      args.set(arg.name, arg);
    }

    template.content.normalize();

    return class extends Component {
      static arguments = args;
      static contents = FinyNode.fromNode(template.content);
    };
  }
}


abstract class FinyNode {
  abstract render(args: BindingContext, state: RenderState): Node[];

  static fromNode(root: Node, slotOutlets = true): FinyNode[] {
    return this.fromNodes(childNodesOf(root), slotOutlets);
  }

  static fromNodes(nodes: Iterable<Node>, slotOutlets = true): FinyNode[] {
    const contents: FinyNode[] = [];
    const skipped = new Set<Element>();

    for (const node of Array.from(nodes)) {
      if (node instanceof Element && skipped.has(node))
        continue;

      const textNodes = TextNode.tryFromNode(node);
      if (textNodes) {
        contents.push(...textNodes);
        continue;
      }

      if (!(node instanceof Element)) {
        logWarn(`Unsupported node is ignored.`, node);
        continue;
      }

      contents.push(this.parseElement(node, slotOutlets, skipped));
    }

    return contents;
  }

  private static parseElement(element: Element, slotOutlets: boolean, skipped: Set<Element>): FinyNode {
    if (element.getAttribute('f-if') != null)
      return this.fromIfChain(element, slotOutlets, skipped);
    return this.fromSingleElement(element, slotOutlets);
  }

  static fromSingleElement(element: Element, slotOutlets: boolean, omitted: Set<string> = new Set()): FinyNode {
    if (!omitted.has('f-for') && element.getAttribute('f-for') != null)
      return new ForNode(
        element.getAttribute('f-for') ?? '',
        this.fromSingleElement(element, slotOutlets, new Set([...omitted, 'f-for']))
      );

    if (slotOutlets && !omitted.has('f-slot') && element.getAttribute('f-slot') != null)
      return SlotNode.fromElement(element, omitted);

    if (!omitted.has('f-component') && element.getAttribute('f-component') != null)
      return DynamicCallNode.fromElement(element, omitted);

    const call = CallNode.tryFromElement(element, omitted);
    if (call) return call;

    const wrap = WrapNode.tryFromElement(element, slotOutlets);
    if (wrap) return wrap;

    return NativeNode.fromElement(element, slotOutlets, omitted);
  }

  private static fromIfChain(element: Element, slotOutlets: boolean, skipped: Set<Element>): IfNode {
    const branches: IfBranch[] = [];

    let branch: Element | null = element;
    let attrName = 'f-if';
    while (branch) {
      const condition = attrName === 'f-else'
        ? 'true'
        : branch.getAttribute(attrName) ?? '';

      branches.push({
        condition: new ExprNode(condition),
        body: this.fromSingleElement(branch, slotOutlets, new Set([attrName])),
      });

      const next = branch.nextElementSibling as Element | null;
      if (!next) break;

      if (next.getAttribute('f-elif') != null) {
        skipped.add(next);
        branch = next;
        attrName = 'f-elif';
        continue;
      }

      if (next.getAttribute('f-else') != null) {
        skipped.add(next);
        branch = next;
        attrName = 'f-else';
        continue;
      }

      break;
    }

    return new IfNode(branches);
  }
}

class NativeNode extends FinyNode {
  constructor(
    public shell: NativeShell,
    public children: FinyNode[],
  ) { super(); }

  render(args: BindingContext, state: RenderState) {
    const children = renderNodes(this.children, args, state);
    return [renderNativeShell(this.shell, args, children)];
  }

  static fromElement(element: Element, slotOutlets: boolean, omitted: Set<string> = new Set()): NativeNode {
    return new NativeNode(
      makeNativeShell(element, omitted),
      FinyNode.fromNodes(element.childNodes, slotOutlets)
    );
  }
}

class TextNode extends FinyNode {
  constructor(public text: string) { super(); }

  render() {
    return [document.createTextNode(this.text)];
  }

  static tryFromNode(node: Node): (TextNode | ExprNode)[] | null {
    if (node.nodeType !== Node.TEXT_NODE)
      return null;

    const text = node.nodeValue ?? '';
    const segs = [] as (TextNode | ExprNode)[];

    let index = 0;
    let buffer = '';
    while (index < text.length) {
      const char = text[index++];

      switch (char) {
        case '$': {
          if (text[index] !== '"') {
            const ident = text.slice(index).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)?.[0];
            if (!ident) {
              buffer += '$';
              continue;
            }

            if (buffer) {
              segs.push(new TextNode(buffer));
              buffer = '';
            }

            segs.push(new ExprNode(ident));
            index += ident.length;
            continue;
          }

          if (buffer) {
            segs.push(new TextNode(buffer));
            buffer = '';
          }

          let start = ++index;
          let level = 0;
          findEnd: for (; index < text.length; index++) {
            switch (text[index]) {
              case '"':
                if (level) break;
                break findEnd;

              case '(': case '[': case '{': level++; break;
              case ')': case ']': case '}': level--; break;
            }
          }

          segs.push(new ExprNode(text.slice(start, index++)));
        } break;

        default: buffer += char;
      }
    }

    if (buffer) segs.push(new TextNode(buffer));
    return segs;
  }
}

class ExprNode extends FinyNode {
  constructor(public expression: string) { super(); }

  render(args: BindingContext): Node[] {
    return [document.createTextNode(String(this.eval(args)))];
  }

  eval<T>(args: BindingContext): T {
    return evalWithContext<T>(this.expression, args);
  }
}

class WrapNode extends FinyNode {
  constructor(public children: FinyNode[]) { super(); }

  render(args: BindingContext, state: RenderState): Node[] {
    return renderNodes(this.children, args, state);
  }

  static tryFromElement(element: Element, slotOutlets: boolean): WrapNode | null {
    if (!isTemplateElement(element)) return null;
    return new WrapNode(FinyNode.fromNode(element.content, slotOutlets));
  }
}

class CallNode extends FinyNode {
  constructor(
    public componentName: string,
    public attributes: AttributeValues,
    public slots: SlotContent,
  ) { super(); }

  render(args: BindingContext): Node[] {
    const component = components.get(this.componentName);
    if (!component) throw new Error(`Component "${this.componentName}" is not registered.`);
    return component.expand(this.attributes, this.slots, args);
  }

  static tryFromElement(element: Element, omitted: Set<string> = new Set()): CallNode | null {
    const componentName = element.tagName.toLowerCase();
    if (!componentNames.has(componentName)) return null;
    return new CallNode(
      componentName,
      collectComponentAttributes(element, omitted),
      collectSlotContent(element));
  }
}

type IfBranch = { condition: ExprNode, body: FinyNode };
class IfNode extends FinyNode {
  constructor(public branches: IfBranch[]) { super(); }

  render(args: BindingContext, state: RenderState): Node[] {
    for (const branch of this.branches)
      if (branch.condition.eval(args))
        return branch.body.render(args, state);
    return [];
  }
}

class ForNode extends FinyNode {
  constructor(
    public expr: string,
    public body: FinyNode,
  ) { super(); }

  render(args: BindingContext, state: RenderState): Node[] {
    if (this.expr.trim() === '')
      throw new Error('f-for attribute cannot be empty.');

    const binding = [...getForBindings(this.expr)];
    return [...evalWithContext<Generator<Record<string, any>>>(
      `(function*() { for (const ${this.expr}) yield { ${binding.join(', ')} }; })()`, args
    )].flatMap(captured => this.body.render({ ...args, ...captured }, state))
  }

  static tryFromElement(element: Element): ForNode | null {
    const expr = element.getAttribute('f-for');
    if (expr == null) return null;

    return new ForNode(expr, FinyNode.fromSingleElement(element, true, new Set(['f-for'])));
  }
}

class DynamicCallNode extends FinyNode {
  constructor(
    public expression: ExprNode,
    public attributes: AttributeValues,
    public slots: SlotContent,
  ) { super(); }

  render(args: BindingContext): Node[] {
    const componentName = String(this.expression.eval(args)).trim();
    const component = components.get(componentName);
    if (!component) throw new Error(`Component "${componentName}" is not registered.`);
    return component.expand(this.attributes, this.slots, args);
  }

  static fromElement(element: Element, omitted: Set<string> = new Set()): DynamicCallNode {
    return new DynamicCallNode(
      new ExprNode(element.getAttribute('f-component') ?? ''),
      collectComponentAttributes(element, new Set([...omitted, 'f-component'])),
      collectSlotContent(element)
    );
  }
}

class SlotNode extends FinyNode {
  constructor(
    public name: string,
    public args: SlotArg[],
    public shell: NativeShell | null,
    public fallback: FinyNode[],
  ) { super(); }

  render(args: BindingContext, state: RenderState): Node[] {
    const content = state.slots.get(this.name);
    const slotArgs = { ...state.parentArgs };

    for (const arg of this.args) {
      if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(arg.name))
        throw new Error(`Invalid slot argument name "${arg.name}".`);
      slotArgs[arg.name] = resolveAttributeValue(arg.value, args);
    }

    if (content)
      state.slots.delete(this.name);

    const children = content
      ? renderNodes(content, slotArgs, { slots: new Map(), parentArgs: slotArgs })
      : renderNodes(this.fallback, args, state);

    if (!this.shell)
      return children;

    return [renderNativeShell(this.shell, args, children)];
  }

  static fromElement(element: Element, omitted: Set<string> = new Set()): SlotNode {
    const args: SlotArg[] = [];
    for (const attr of Array.from(element.attributes))
      if (attr.name.startsWith('f-arg:'))
        args.push({ name: attr.name.slice(6), value: attr.value });

    return new SlotNode(
      element.getAttribute('f-slot')?.trim() ?? '',
      args,
      isTemplateElement(element) ? null : makeNativeShell(element, new Set([...omitted, 'f-slot'])),
      FinyNode.fromNodes(childNodesOf(element), true),
    );
  }
}

function addSlotContent(slots: SlotContent, name: string, nodes: FinyNode[]) {
  const content = slots.get(name);
  content ? content.push(...nodes) : slots.set(name, nodes);
}

function collectSlotContent(element: Element): SlotContent {
  const slots: SlotContent = new Map();
  const putNodes: Element[] = [];
  const defaultNodes: Node[] = [];

  for (const child of Array.from(childNodesOf(element))) {
    if (child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim() === '')
      continue;

    if (child instanceof Element && child.tagName.toLowerCase() === 'put') {
      putNodes.push(child);
      continue;
    }

    if (child.nodeType === Node.TEXT_NODE || child instanceof Element)
      defaultNodes.push(child);
  }

  if (putNodes.length > 0 && defaultNodes.length > 0)
    throw new Error('Cannot mix <put> children with direct slot content.');

  for (const put of putNodes)
    addSlotContent(
      slots,
      put.getAttribute('f-slot')?.trim() ?? '',
      FinyNode.fromNodes(put.childNodes, false)
    );

  if (defaultNodes.length > 0)
    addSlotContent(slots, '', FinyNode.fromNodes(defaultNodes, false));

  return slots;
}


class Argument {
  static typeConstructors: Record<string, Function> = {
    'str': String,
    'num': Number,
    'bool': (value: any) => {
      if ([true, 'true'].includes(value)) return true;
      if ([false, 'false'].includes(value)) return false;
      throw new Error(`Invalid boolean value \`${value}\`.`);
    },
    'obj': (value: any) => {
      if (typeof value !== 'string')
        return value;

      try {
        return JSON.parse(value);
      } catch {
        throw new Error(`Invalid object value \`${value}\`. Must be a valid JSON string.`);
      }
    },
  };

  constructor(
    public name: string,
    public typeStr: string,
    public construct: Function,
    public optional: boolean,
    public defaultValue: any
  ) {}

  static fromAttribute(attr: Attr): Argument {
    const [name, type, ...rest] = attr.name.split(':');
    if (rest.length > 0)
      throw new Error(`Invalid attribute name "${attr.name}".`);
    if (!/^[a-z][a-z0-9_-]*$/.test(name))
      throw new Error(`Invalid argument name "${name}".`);

    const optional = type?.endsWith('?') ?? false;
    const typeName = optional ? type?.slice(0, -1) || 'str' : type || 'str';
    const constructor = Argument.typeConstructors[typeName];
    if (!constructor)
      throw new Error(`Invalid argument type "${typeName}" in attribute "${attr.name}". Supported types are ${Object.keys(this.typeConstructors)}.`);
    if (attr.value === 'undefined')
      throw new Error(`Invalid default value "undefined" for argument "${name}".`);

    const defaultValue = optional
      ? (attr.value === 'null') ? null : constructor(attr.value)
      : (typeName !== 'str' && attr.value === '') ? undefined : constructor(attr.value);

    return new Argument(name, type || 'str', constructor, optional || defaultValue !== undefined, defaultValue);
  }
}

function isNestedComponent(element: Element): boolean {
  for (let parent = element.parentNode; parent; parent = parent.parentNode)
    if (parent instanceof Element && componentNames.has(parent.tagName.toLowerCase()))
      return true;
  return false;
}

function applyComponents() {
  const time = Date.now();
  let applied = false;

  do {
    applied = false;
    for (const name of componentNames) {
      for (const element of Array.from(document.querySelectorAll(name))) {
        if (!element.parentNode || isNestedComponent(element))
          continue;

        try {
          const component = components.get(name);
          if (!component) continue;
          applied = component.render(element) || applied;
        } catch (error) {
          logError(`Error applying component "${name}":`, error, element);
        }
      }
    }
  } while (applied);

  logInfo(`Applied components in ${Date.now() - time}ms`);
}


window.onload = function() {
  Component.registerAll();
  applyComponents();
}
