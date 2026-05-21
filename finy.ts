

const logger = new (class Logger {
  #enabled: boolean = true;

  enable () { this.#enabled = true; }
  disable() { this.#enabled = false; }

  debug(...args: any[]) { if (this.#enabled) console.debug(...args); }
  info (...args: any[]) { if (this.#enabled) console.info (...args); }
  warn (...args: any[]) { if (this.#enabled) console.warn (...args); }
  error(...args: any[]) { if (this.#enabled) console.error(...args); }

  tap<T>(value: T): T {
    this.debug('tap:', value);
    return value;
  }

  tapJson<T>(value: T): T {
    this.debug('tap:', JSON.stringify(value, null, 2));
    return value;
  }
})();


type BindingContext = Record<string, any>;

function evalWithContext<T>(code: string, context: BindingContext): T {
  const func = new Function(...Object.keys(context), `"use strict"; return (${code});`);
  return func(...Object.values(context));
}

function findEnclosedPatternEnd(expression: string, open: string, close: string): number {
  let level = 0;

  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === open) level++;
    if (char === close) level--;
    if (level === 0) return index;
  }

  return -1;
}

function extractIdentifiers(expression: string): Set<string> {
  const identifiers = new Set<string>();
  const trimmed = expression.trimStart();

  const ident = trimmed.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)?.[0];
  if (ident) {
    identifiers.add(ident);
    return identifiers;
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const open = trimmed[0];
    const close = open === '[' ? ']' : '}';
    const end = findEnclosedPatternEnd(trimmed, open, close);
    if (end === -1)
      throw new Error(`Mismatched ${open === '[' ? 'brackets' : 'braces'} in expression "${expression}".`);

    const pattern = trimmed.slice(1, end);
    for (const match of pattern.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$]*/g))
      identifiers.add(match[0]);

    return identifiers;
  }

  throw new Error(`Unsupported expression format "${expression}". Only simple identifiers and destructuring patterns are supported.`);
}

function findStringLiteralEnd(text: string, start: number): number {
  const quote = text[start];
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === quote) {
      return i;
    }
  }

  return -1;
}

function unescapeTextBindingExpression(expression: string): string {
  return expression.replace(/\\(["\\])/g, '$1');
}

function interpolateTextBindings(text: string, context: BindingContext): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    const dollar = text.indexOf('$', index);
    if (dollar === -1) {
      result += text.slice(index);
      break;
    }

    result += text.slice(index, dollar);
    const next = text[dollar + 1];

    if (next === '"') {
      const end = findStringLiteralEnd(text, dollar + 1);
      if (end === -1) {
        result += text.slice(dollar);
        break;
      }

      const expression = unescapeTextBindingExpression(text.slice(dollar + 2, end));
      result += String(evalWithContext<any>(expression, context));
      index = end + 1;
      continue;
    }

    const ident = text.slice(dollar + 1).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)?.[0];
    if (ident) {
      result += String(evalWithContext<any>(ident, context));
      index = dollar + 1 + ident.length;
      continue;
    }

    result += '$';
    index = dollar + 1;
  }

  return result;
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


class Argument {
  constructor(
    public name: string,
    public typeStr: string,
    public construct: Function,
    public optional: boolean,
    public defaultValue: any
  ) {}

  private static typeConstructors: Record<string, Function> = {
    'str': String,
    'num': Number,
    'bool': (value: any) => {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error(`Invalid boolean value "${value}". Must be "true" or "false".`);
    },
  };

  static fromAttribute(attr: Attr): Argument | null {
    // ignore finy and id attributes since they are reserved for component definition and identification
    if (attr.name === 'finy' || attr.name === 'id') { return null; }

    // split name and type
    const [name, _type, ...rest] = attr.name.split(':');

    // make sure rest must be empty
    if (rest.length > 0) {
      logger.error(`Invalid argument attribute name "${attr.name}". Must be in the format "name", "name:type", "name:?" or "name:type?" for optional arguments.`, attr);
      return null;
    }

    // validate name
    if (!name || !/^[a-z][a-z0-9_-]*$/.test(name)) {
      logger.error(`Invalid argument name "${name}". Must start with a lower letter and contain only lower letters, numbers, underscores, or hyphens.`, attr);
      return null;
    }

    let type = _type || 'str';

    // parse type
    const optional = type?.endsWith('?') ?? false;
    const typeName = optional ? type.slice(0, -1) ?? 'str' : type;
    const constructor = Argument.typeConstructors[typeName];

    if (!constructor) {
      logger.error(`Invalid argument type "${typeName}" in attribute "${attr.name}". Supported types are ${Object.keys(this.typeConstructors)}.`, attr);
      return null;
    }

    if (attr.value === 'undefined') {
      logger.error(`Invalid default value "undefined" for argument "${name}". Default values cannot be "undefined". Use an empty string for no default value or "null" for a null default value.`, attr);
      return null;
    }

    const defaultValue = optional
      ? (attr.value === 'null') ? null : constructor(attr.value)
      : (typeName !== 'str' && attr.value === '') ? undefined : constructor(attr.value);
    return new Argument(name, type, constructor, optional || defaultValue !== undefined, defaultValue);
  }
}

abstract class Component {
  static template: HTMLTemplateElement;
  static arguments: Map<string, Argument> = new Map();

  private static renderChildren(parent: Node, args: BindingContext) {
    for (const node of parent.childNodes)
      this.renderNode(node, args);
  }

  private static renderNode(node: Node, args: BindingContext) {
    if (!node.parentNode) return;

    if (node.nodeType === Node.TEXT_NODE) {
      node.nodeValue = interpolateTextBindings(node.nodeValue ?? '', args);
      return;
    }

    if (!(node instanceof Element)) return;

    const element = this.resolveIfChain(node, args);
    if (!element) return;

    const forAttr = element.attributes.getNamedItem('f-for');
    if (forAttr) {
      this.expandFor(element, forAttr.value.trim(), args);
      return;
    }

    const component = components.get(element.tagName.toLowerCase());
    component ? component.apply(element, args) : this.renderChildren(element, args);
  }

  private static resolveIfChain(element: Element, args: BindingContext): Element | null {
    const ifAttr = element.attributes.getNamedItem('f-if');
    if (!ifAttr) return element;

    element.removeAttribute('f-if');

    const condition = ifAttr.value.trim();
    if (condition === '')
      throw new Error('f-if attribute cannot be empty');

    const chain: [Element, condition: string][] = [[element, condition]];
    while (true) {
      const next = chain[chain.length - 1][0].nextElementSibling;
      if (!next) break;

      const elseifAttr = next.attributes.getNamedItem('f-elif');
      if (elseifAttr) {
        next.removeAttribute('f-elif');

        let condition = elseifAttr.value.trim();
        if (condition === '')
          throw new Error('f-elif attribute cannot be empty');

        chain.push([next, condition]);
        continue;
      }

      if (next.attributes.getNamedItem('f-else')) {
        next.removeAttribute('f-else');
        chain.push([next, 'true']);
      }

      break;
    }

    const selected = chain.find(([, condition]) =>
      evalWithContext(condition, args))?.[0] ?? null;
    if (selected && selected !== element)
      element.replaceWith(selected);

    for (const [branch] of chain)
      if (branch !== selected)
        branch.remove();

    return selected;
  }

  private static expandFor(element: Element, expression: string, args: BindingContext) {
    element.removeAttribute('f-for');

    if (expression === '')
      throw new Error('f-for attribute cannot be empty');

    const parent = element.parentNode;
    if (!parent) return;

    const identifiers = extractIdentifiers(expression);
    const iterable = evalWithContext<Generator<Object>>(
      `(function*() { for (const ${expression}) yield { ${[...identifiers].join(', ')} }; })() `,
      args);
    for (const iterationContext of iterable) {
      const context = { ...args, ...iterationContext };
      const clone = element.cloneNode(true) as Element;
      parent.insertBefore(clone, element);
      this.renderNode(clone, context);
    }

    element.remove();
  }

  static apply(element: Element, parentArgs: BindingContext = {}): boolean {
    try {
      const args: BindingContext = {};
      for (const [name, arg] of this.arguments) {
        let value = arg.defaultValue;

        const attr = element.attributes.getNamedItem(name);
        if (attr)
          value = arg.construct(resolveAttributeValue(attr.value, parentArgs));
        else if (!arg.optional)
          throw new Error(`Missing required argument "${name}" for component "${this.name}"`);

        args[name] = value;
      }

      const template = this.template.cloneNode(true) as HTMLTemplateElement;
      this.renderChildren(template.content, args);
      element.replaceWith(template.content);
      return true;
    }

    catch (error) {
      logger.error(`Error applying component "${this.name}":`, error, element);
      return false;
    }
  }
}

const components = new Map<string, typeof Component>();

function registerComponents() {
  for (const template of document.querySelectorAll('template')) {
    // filter out non-finy templates early to avoid processing irrelevant things
    if (template.attributes.getNamedItem('finy')?.value == null)
      continue;

    // remove it from the DOM
    template.remove();

    // make sure templates are validly named and not duplicated before doing any more work
    const name = template.id?.trim();
    if (!name) {
      logger.error('Component template is missing the id', template);
      continue;
    } else if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      logger.error(`Invalid component id "${name}". Must start with a lower letter and contain only lower letters, numbers, underscores, or hyphens.`, template);
      continue;
    } else if (components.has(name)) {
      logger.error(`Component with id "${name}" is already registered`, template);
      continue;
    }

    // process arguments
    const args = new Map<string, Argument>(([...template.attributes]
      .map(Argument.fromAttribute)
      .map(arg => arg ? [arg.name, arg] as const : null)
      .filter(Boolean) as [string, Argument][]));

    logger.info(`Registered component "${name}" with arguments:`);
    for (const arg of args.values())
      logger.info(`  - ${arg.name}: ${arg.typeStr}${arg.optional ? '?' : ''} (default: ${arg.defaultValue})`);

    components.set(name, class extends Component {
      static template = template;
      static arguments = args;
    });
  }
}


function applyComponents() {
  const time = Date.now();

  let applied = false;
  do {
    applied = false;
    for (const [name, component] of components)
      for (const ele of document.querySelectorAll(name))
        applied ||= component.apply(ele);
  } while (applied);

  logger.info(`Applied components in ${Date.now() - time}ms`);
}


(window as any).finy = {
  enableLogging() { logger.enable(); },
  disableLogging() { logger.disable(); },
  range: function*(start: number, end?: number): Generator<number> {
    [start, end] = end === undefined ? [0, start] : [start, end];
    for (let i = start; i < end; i++) yield i;
  },
};


window.onload = function() {
  registerComponents();
  applyComponents();
};
