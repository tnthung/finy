# Finy

Finy is a tiny HTML component runtime. Define reusable elements with native
`<template>` tags, then use them directly in the page.

Finy runs in the browser on `window.onload`. It registers every
`<template finy id="...">`, removes the template from the DOM, and replaces
matching elements with rendered template content.

## Install

Add the script to your HTML:

```html
<script src="https://tnthung.github.io/finy/finy.js"></script>
```

## Components

Define a component with `template[finy]`. The template `id` becomes the element
name.

```html
<template finy id="hello-card" name:str="World">
  <p>Hello, $name.</p>
</template>

<hello-card name="Ada"></hello-card>
```

Output:

```html
<p>Hello, Ada.</p>
```

Component names must start with a lowercase letter and can contain lowercase
letters, numbers, underscores, and hyphens.

## Dynamic Components

Use `f-component` on a `<template>` wrapper when the component name comes from
the current binding context. The expression must resolve to a registered
component name. The wrapper is removed, and the selected component renders in
its place:

```html
<template finy id="foo">
  <p>This is Foo</p>
</template>

<template finy id="bar">
  <p>This is Bar</p>
</template>

<template finy id="dyn" name:str>
  <template f-component="name"></template>
</template>
```

Attributes on the `template[f-component]` are passed as component arguments.
Children inside the template `.content` are passed as slot content.

## Arguments

Template attributes declare component arguments:

```html
<template finy id="user-row" name:str="Unknown" age:num="0" active:bool="true">
  <p>$name is $age years old.</p>
  <strong f-if="active">active</strong>
</template>
```

Supported argument types:

| Type | Example | Result |
| --- | --- | --- |
| `str` | `name:str="Ada"` | string |
| `num` | `count:num="3"` | number |
| `bool` | `active:bool="true"` | boolean |

If no type is given, `str` is used:

```html
<template finy id="label" text="Untitled">
  <span>$text</span>
</template>
```

Use JavaScript-friendly argument names when you want to reference them in
bindings, such as `name`, `item_count`, or `is_active`.

## Text Bindings

Use `$name` for simple identifiers:

```html
<p>Hello, $name.</p>
```

Use `$"..."` for JavaScript expressions:

```html
<p>$"name.toUpperCase()"</p>
<p>$"items.length" items</p>
```

The expression runs against the current component, loop, or slot context.

## Conditions

Use `f-if`, `f-elif`, and `f-else` on sibling elements:

```html
<template finy id="status-badge" state:str="pending">
  <span f-if="state === 'active'">Active</span>
  <span f-elif="state === 'pending'">Pending</span>
  <span f-else>Disabled</span>
</template>
```

Use `<template>` when the branch should not leave a wrapper element in the
rendered DOM. Template control-flow renders the selected template's `.content`,
not the `<template>` element itself:

```html
<template finy id="foo" a:num>
  <template f-if="a > 5">
    <p>$a is greater than 5</p>
    <div>a * 2 = $"a*2"</div>
  </template>
  <template f-elif="a === 5">
    <p>$a is equal to 5</p>
    <div>a + 10 = $"a+10"</div>
  </template>
  <template f-else>
    <p>$a is less than 5</p>
    <div>a - 2 = $"a-2"</div>
  </template>
</template>
```

When an element has both `f-if` and `f-for`, the condition is checked first.

## Loops

Use `f-for` with normal JavaScript `for...of` or `for...in` syntax after
`const`.

```html
<template finy id="number-list">
  <ul>
    <li f-for="n of finy.range(1, 4)">Number $n</li>
  </ul>
</template>
```

Output:

```html
<ul>
  <li>Number 1</li>
  <li>Number 2</li>
  <li>Number 3</li>
</ul>
```

`f-for` mirrors JavaScript behavior:

```html
<p f-for="value of ['a', 'b']">$value</p>
<p f-for="key in { a: 1, b: 2 }">$key</p>
<p f-for="[key, value] of Object.entries(data)">$key: $value</p>
```

`f-for` can also repeat invisible template content:

```html
<template f-for="n of finy.range(1, 4)">
  <p>Number $n</p>
  <div>Double $"n * 2"</div>
</template>
```

## Slots

Use `f-slot` inside a component to receive caller content.

```html
<template finy id="panel">
  <section>
    <header f-slot="title">Untitled</header>
    <div f-slot>No content</div>
  </section>
</template>

<panel>
  <put f-slot="title">Profile</put>
  <put>Hello from the body.</put>
</panel>
```

Output:

```html
<section>
  <header>Profile</header>
  <div>Hello from the body.</div>
</section>
```

Slot rules:

- `f-slot` is the unnamed slot.
- `f-slot="name"` is a named slot.
- Slot children are fallback content when nothing is provided.
- A normal element with `f-slot` keeps the element and replaces its children.
- `template[f-slot]` is replaced completely by the provided or fallback content.
- Direct non-`put` children go to the unnamed slot.
- `<put>` goes to the unnamed slot.
- `<put f-slot="name">` goes to a named slot.
- Do not mix `<put>` children with direct non-`put` children in the same call.

Direct unnamed content is allowed:

```html
<panel>
  Plain body content.
</panel>
```

Use `template[f-slot]` when you want the slot to replace the placeholder itself:

```html
<template finy id="layout">
  <main>
    <template f-slot>
      <p>Fallback content</p>
    </template>
  </main>
</template>
```

## Slot Arguments

Slotted caller content normally renders with the caller's context. A component
can pass values from its own context into a slot with `f-arg:name="expression"`.

```html
<template finy id="repeat-box" count:num="3">
  <template f-slot f-arg:count="count"></template>
</template>

<repeat-box count="3">
  <put>
    <p f-for="i of finy.range(count)">Item $i</p>
  </put>
</repeat-box>
```

## Utilities

Finy exposes a small `window.finy` object:

```js
finy.range(3)       // 0, 1, 2
finy.range(1, 4)    // 1, 2, 3
finy.range(4, 1)    // 4, 3, 2
```

Logging is enabled by default:

```js
finy.disableLogging()
finy.enableLogging()
```

## License

MIT
