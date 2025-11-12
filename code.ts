figma.showUI(__html__, { visible: false }); // UI needed for MathJax rendering

let processedCount = 0;
let totalLatexBlocks = 0;

figma.ui.onmessage = (msg) => {
  if (msg.type === "latex-svg") {
    try {
      const node = figma.createNodeFromSvg(msg.svg);

      // The SVG might be wrapped in a group, get the actual content
      let svgNode: SceneNode;
      if (node.type === 'FRAME' && node.children.length > 0) {
        svgNode = node.children[0];
        // Move out of the frame
        const x = msg.x;
        const y = msg.y;
        figma.currentPage.appendChild(svgNode);
        svgNode.x = x;
        svgNode.y = y;
        node.remove();
      } else {
        svgNode = node;
        svgNode.x = msg.x;
        svgNode.y = msg.y;
        figma.currentPage.appendChild(svgNode);
      }

      svgNode.name = "LaTeX: " + msg.latex.substring(0, 40);

      processedCount++;
      if (processedCount >= totalLatexBlocks) {
        figma.notify("✅ Markdown + LaTeX formatting complete!");
        figma.closePlugin();
      }
    } catch (error) {
      console.error("Error creating SVG node:", error);
      figma.notify("❌ Error creating SVG for: " + msg.latex.substring(0, 20));
      processedCount++;
      if (processedCount >= totalLatexBlocks) {
        figma.closePlugin();
      }
    }
  } else if (msg.type === "error") {
    console.error("LaTeX rendering error:", msg.error, msg.latex);
    figma.notify("❌ LaTeX error: " + msg.latex.substring(0, 20));
    processedCount++;
    if (processedCount >= totalLatexBlocks) {
      figma.closePlugin();
    }
  }
};

async function processTextNodes() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.notify("⚠️ Please select at least one text layer");
    figma.closePlugin();
    return;
  }

  for (const node of selection) {
    if (node.type !== "TEXT") continue;

    await figma.loadFontAsync(node.fontName as FontName);

    const text = node.characters;

    // Support both $...$ (inline) and $$...$$ (display) LaTeX
    const displayLatexRegex = /\$\$([\s\S]+?)\$\$/g;
    const inlineLatexRegex = /\$([^\$\n]+?)\$/g;
    const boldRegex = /\*\*(.*?)\*\*/g;

    const latexBlocks: { latex: string; x: number; y: number; display: boolean }[] = [];

    let processedText = text;

    // First, extract display math blocks ($$...$$) - must be done before inline
    let displayMatches = [...text.matchAll(displayLatexRegex)];
    for (const match of displayMatches) {
      const latex = match[1].trim();
      latexBlocks.push({
        latex: latex,
        x: node.x,
        y: node.y,
        display: true
      });
    }

    // Remove display math blocks from text
    processedText = processedText.replace(displayLatexRegex, '');

    // Then handle inline math ($...$)
    let inlineMatches = [...processedText.matchAll(inlineLatexRegex)];
    for (const match of inlineMatches) {
      const latex = match[1].trim();
      latexBlocks.push({
        latex: latex,
        x: node.x,
        y: node.y,
        display: false
      });
    }

    // Remove inline math blocks from text
    processedText = processedText.replace(inlineLatexRegex, '');

    // Apply bold styling
    await figma.loadFontAsync({ family: "Inter", style: "Bold" });
    const boldMatches: RegExpMatchArray[] = [];
    let match;
    while ((match = boldRegex.exec(processedText)) !== null) {
      boldMatches.push(match);
    }

    let plainText = processedText.replace(boldRegex, "$1"); // remove ** markers

    // Clean up extra whitespace
    plainText = plainText.replace(/\n\n\n+/g, '\n\n');
    plainText = plainText.trim();

    node.characters = plainText;

    // Apply bold formatting
    for (const match of boldMatches) {
      const start = plainText.indexOf(match[1]);
      if (start !== -1) {
        const end = start + match[1].length;
        try {
          node.setRangeFontName(start, end, { family: "Inter", style: "Bold" });
        } catch (e) {
          console.log("Could not apply bold:", e);
        }
      }
    }

    // Send LaTeX blocks to UI for rendering
    let offsetY = node.y + node.height + 16;
    for (const block of latexBlocks) {
      totalLatexBlocks++;
      figma.ui.postMessage({
        type: "render-latex",
        latex: block.latex,
        x: node.x,
        y: offsetY,
        display: block.display
      });
      // Display math needs more space
      offsetY += block.display ? 80 : 40;
    }
  }

  if (totalLatexBlocks === 0) {
    figma.notify("✅ Markdown formatting applied! No LaTeX blocks found.");
    figma.closePlugin();
  }
}

processTextNodes();
