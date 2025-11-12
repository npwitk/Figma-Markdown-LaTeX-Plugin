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

        // Append to the correct parent (frame or page)
        const parentNode = msg.parentId ? figma.getNodeById(msg.parentId) as (BaseNode & ChildrenMixin) : null;
        if (parentNode && 'appendChild' in parentNode) {
          parentNode.appendChild(svgNode);
        } else {
          figma.currentPage.appendChild(svgNode);
        }

        svgNode.x = x;
        svgNode.y = y;
        node.remove();
      } else {
        svgNode = node;
        svgNode.x = msg.x;
        svgNode.y = msg.y;

        // Append to the correct parent (frame or page)
        const parentNode = msg.parentId ? figma.getNodeById(msg.parentId) as (BaseNode & ChildrenMixin) : null;
        if (parentNode && 'appendChild' in parentNode) {
          parentNode.appendChild(svgNode);
        } else {
          figma.currentPage.appendChild(svgNode);
        }
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
    const italicRegex = /\*([^\*\n]+?)\*/g;
    const h1Regex = /^# (.+)$/gm;
    const h2Regex = /^## (.+)$/gm;

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

    // Detect headers and store their formatting info
    const h1Matches: { text: string; index: number }[] = [];
    const h2Matches: { text: string; index: number }[] = [];

    let match;
    while ((match = h1Regex.exec(processedText)) !== null) {
      h1Matches.push({ text: match[1], index: match.index });
    }
    while ((match = h2Regex.exec(processedText)) !== null) {
      h2Matches.push({ text: match[1], index: match.index });
    }

    // Remove header markers (## and #)
    processedText = processedText.replace(h1Regex, "$1");
    processedText = processedText.replace(h2Regex, "$1");

    // Extract bold matches (before removing markers)
    await figma.loadFontAsync({ family: "Inter", style: "Bold" });
    const boldMatches: RegExpMatchArray[] = [];
    while ((match = boldRegex.exec(processedText)) !== null) {
      boldMatches.push(match);
    }

    // Extract italic matches (before removing markers) - must be done AFTER bold to avoid conflicts
    await figma.loadFontAsync({ family: "Inter", style: "Italic" });
    const italicMatches: RegExpMatchArray[] = [];
    let tempText = processedText.replace(boldRegex, "$1"); // Remove bold markers for italic matching
    while ((match = italicRegex.exec(tempText)) !== null) {
      italicMatches.push(match);
    }

    let plainText = processedText.replace(boldRegex, "$1"); // remove ** markers
    plainText = plainText.replace(italicRegex, "$1"); // remove * markers

    // Clean up extra whitespace
    plainText = plainText.replace(/\n\n\n+/g, '\n\n');
    plainText = plainText.trim();

    node.characters = plainText;

    // Get the current font size as baseline
    const baseFontSize = node.fontSize as number;

    // Apply header font sizes
    for (const h1 of h1Matches) {
      const start = plainText.indexOf(h1.text);
      if (start !== -1) {
        const end = start + h1.text.length;
        try {
          node.setRangeFontSize(start, end, baseFontSize * 2); // H1: 2x size
        } catch (e) {
          console.log("Could not apply H1 size:", e);
        }
      }
    }

    for (const h2 of h2Matches) {
      const start = plainText.indexOf(h2.text);
      if (start !== -1) {
        const end = start + h2.text.length;
        try {
          node.setRangeFontSize(start, end, baseFontSize * 1.5); // H2: 1.5x size
        } catch (e) {
          console.log("Could not apply H2 size:", e);
        }
      }
    }

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

    // Apply italic formatting
    for (const match of italicMatches) {
      const start = plainText.indexOf(match[1]);
      if (start !== -1) {
        const end = start + match[1].length;
        try {
          node.setRangeFontName(start, end, { family: "Inter", style: "Italic" });
        } catch (e) {
          console.log("Could not apply italic:", e);
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
        display: block.display,
        parentId: node.parent ? node.parent.id : null
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
