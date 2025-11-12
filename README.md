# Markdown + LaTeX Formatter

A Figma plugin that transforms markdown and LaTeX text into beautifully formatted text with rendered mathematical equations as crisp SVG graphics.

## Features

- **Markdown Support**: Converts `**bold**` text to actual bold styling
- **Display Math Rendering**: Converts `$$...$$` blocks into beautifully rendered equations as SVG
- **Inline Math Rendering**: Converts `$...$` into rendered math SVG objects
- **Automatic Formatting**: Processes selected text layers with a single click
- **Uses MathJax**: Professional-quality math rendering with full LaTeX support

## How to Use

### 1. Install the Plugin in Figma

1. Open Figma Desktop App
2. Go to **Plugins > Development > Import plugin from manifest**
3. Select the `manifest.json` file from this directory
4. The plugin will appear in your plugins menu

### 2. Format Your Text

1. Create a text layer in Figma
2. Type your markdown + LaTeX content. For example:

```
Consider the BVP:

$$u'' = -u, \quad 0 < t < b$$

with boundary conditions:

$$u(0) = 0, \quad u(b) = \beta$$

where $b$ is an integer multiple of $\pi$.

**Analysis:**
- The general solution of the ODE satisfying $u(0) = 0$ is $u(t) = c\sin(t)$ for any constant $c$
- Because $b$ is an integer multiple of $\pi$: $c\sin(b) = 0$ for any $c$
- **Result:**
    - **Infinitely many solutions** if $\beta = 0$
    - **No solution** if $\beta \neq 0$
```

3. Select the text layer
4. Run the plugin: **Plugins > Development > Markdown + LaTeX Formatter**
5. Watch the magic happen!

### Result

- Text with `**bold**` becomes actually bold
- Display math `$$...$$` blocks are removed from text and rendered as separate SVG equation objects
- Inline math `$...$` is removed from text and rendered as separate smaller SVG objects
- Clean, professional mathematical notation in vector format

## Syntax Reference

| Syntax | Result |
|--------|--------|
| `**bold text**` | Bold formatted text |
| `$$x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$$` | Rendered display equation (large SVG) |
| `$x^2$` | Rendered inline math (smaller SVG) |
| `$b$ is a constant` | Creates SVG for `b`, leaves "is a constant" as text |

## Development

### Prerequisites

- Node.js and npm installed
- Figma Desktop App

### Setup

```bash
npm install
npm run build
```

### Development Workflow

```bash
npm run watch
```

This will automatically recompile TypeScript when you make changes.

## Technical Details

- Built with TypeScript
- Uses **MathJax 3** (CDN version) for math rendering
- Converts LaTeX to SVG for perfect vector graphics in Figma
- Supports both display math (`$$...$$`) and inline math (`$...$`)
- All math is rendered as separate SVG objects positioned below the original text

## Troubleshooting

**Plugin doesn't show up in Figma:**
- Make sure you're using Figma Desktop App (not browser version)
- Re-import the plugin manifest

**Math not rendering:**
- Check your LaTeX syntax
- Make sure you're using `$$...$$` for display math
- Check browser console for errors

**Bold text not working:**
- Ensure you have Inter font installed (or modify code.ts to use a different font)

## License

MIT
