import React from 'react';
import katex from 'katex';

/**
 * Converts a LaTeX math expression into W3C native `<math xmlns="http://www.w3.org/1998/Math/MathML">`
 * markup using KaTeX (`output: 'mathml'`), falling back gracefully to readable text if malformed.
 */
function renderLatexToMathMlHtml(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex.trim(), {
      output: 'mathml',
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    return `<code>${latex}</code>`;
  }
}

/**
 * Parse inline markdown syntax including:
 * - Native inline MathML (`<math ...>...</math>`)
 * - Display LaTeX math (`$$ ... $$` or `\[ ... \]`)
 * - Inline LaTeX math (`\( ... \)` or `$ ... $`)
 * - Inline code (`` `code` ``)
 * - Bold-italic (`***text***`), bold (`**text**`), italic (`*text*`)
 * - Markdown links (`[label](url)`)
 */
function parseInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let keyIdx = 0;

  // Token pattern order matters:
  // 1. Native <math ...>...</math>
  // 2. Inline code `...`
  // 3. Display math $$...$$ or \[...\]
  // 4. Inline math \(...\) or $...$ (avoid matching standalone currency like $100 followed by space)
  // 5. Bold/italic ***...***, **...**, *...*
  // 6. Links [...](...)
  const tokenRegex =
    /(<math[\s\S]*?<\/math>|`[^`]+`|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s)(?:\\.|[^$\\])+?(?<!\s)\$|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/;

  while (remaining.length > 0) {
    const match = tokenRegex.exec(remaining);
    if (!match) {
      nodes.push(remaining);
      break;
    }

    if (match.index > 0) {
      nodes.push(remaining.slice(0, match.index));
    }

    const token = match[0];

    if (token.startsWith('<math') && token.endsWith('</math>')) {
      nodes.push(
        <span
          key={`mathml-inline-${keyIdx++}`}
          style={{
            display: 'inline-block',
            margin: '0 2px',
            color: '#e2e8f0',
            fontSize: '1.03em',
          }}
          dangerouslySetInnerHTML={{ __html: token }}
        />
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={`code-${keyIdx++}`}
          style={{
            background: 'rgba(30, 41, 59, 0.85)',
            border: '1px solid rgba(148, 163, 184, 0.25)',
            borderRadius: '4px',
            padding: '1px 5px',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: '0.84em',
            color: '#c4b5fd',
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (
      (token.startsWith('$$') && token.endsWith('$$')) ||
      (token.startsWith('\\[') && token.endsWith('\\]'))
    ) {
      const innerLatex = token.slice(2, -2);
      const mathMlHtml = renderLatexToMathMlHtml(innerLatex, true);
      nodes.push(
        <div
          key={`math-disp-${keyIdx++}`}
          style={{
            margin: '10px 0',
            padding: '8px 12px',
            overflowX: 'auto',
            textAlign: 'center',
            color: '#f8fafc',
            fontSize: '1.06em',
          }}
          dangerouslySetInnerHTML={{ __html: mathMlHtml }}
        />
      );
    } else if (
      (token.startsWith('\\(') && token.endsWith('\\)')) ||
      (token.startsWith('$') && token.endsWith('$'))
    ) {
      const innerLatex =
        token.startsWith('\\(') && token.endsWith('\\)')
          ? token.slice(2, -2)
          : token.slice(1, -1);
      const mathMlHtml = renderLatexToMathMlHtml(innerLatex, false);
      nodes.push(
        <span
          key={`math-inl-${keyIdx++}`}
          style={{
            display: 'inline-block',
            margin: '0 2px',
            color: '#e2e8f0',
            fontSize: '1.03em',
          }}
          dangerouslySetInnerHTML={{ __html: mathMlHtml }}
        />
      );
    } else if (token.startsWith('***') && token.endsWith('***')) {
      nodes.push(
        <strong
          key={`bi-${keyIdx++}`}
          style={{ color: '#f8fafc', fontStyle: 'italic' }}
        >
          {parseInlineMarkdown(token.slice(3, -3))}
        </strong>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong
          key={`b-${keyIdx++}`}
          style={{ color: '#f8fafc', fontWeight: 700 }}
        >
          {parseInlineMarkdown(token.slice(2, -2))}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em
          key={`i-${keyIdx++}`}
          style={{ color: '#e2e8f0', fontStyle: 'italic' }}
        >
          {parseInlineMarkdown(token.slice(1, -1))}
        </em>
      );
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push(
          <a
            key={`a-${keyIdx++}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#38bdf8', textDecoration: 'underline' }}
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }

    remaining = remaining.slice(match.index + token.length);
  }

  return nodes;
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  return cells.length >= 2 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Renders a Markdown document (including native MathML `<math>...</math>`, LaTeX `$ ... $` / `$$ ... $$`
 * rendered into native browser MathML, GitHub-Flavored Markdown tables, code fences, headings, lists,
 * blockquotes, and inline emphasis) as styled React elements.
 */
export const MarkdownRenderer: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === '') {
      i++;
      continue;
    }

    // 1. Multi-line or single-line Display Math Block ($$ ... $$ or \[ ... \])
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      const closeDelim = trimmed.startsWith('$$') ? '$$' : '\\]';
      const openLen = 2;

      // Single-line display math e.g. $$ E = mc^2 $$
      if (trimmed.length > 4 && trimmed.endsWith(closeDelim)) {
        const innerLatex = trimmed.slice(openLen, -closeDelim.length);
        const mathMlHtml = renderLatexToMathMlHtml(innerLatex, true);
        elements.push(
          <div
            key={`math-block-${blockKey++}`}
            style={{
              margin: '12px 0',
              padding: '10px 14px',
              borderRadius: '8px',
              background: 'rgba(15, 23, 42, 0.55)',
              border: '1px solid rgba(167, 139, 250, 0.2)',
              overflowX: 'auto',
              textAlign: 'center',
              color: '#f8fafc',
              fontSize: '1.08rem',
            }}
            dangerouslySetInnerHTML={{ __html: mathMlHtml }}
          />
        );
        i++;
        continue;
      }

      // Multi-line display math block
      const mathLines: string[] = [];
      const firstLineRest = trimmed.slice(openLen);
      if (firstLineRest) mathLines.push(firstLineRest);
      i++;
      while (i < lines.length && !lines[i].trim().endsWith(closeDelim)) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const lastTrimmed = lines[i].trim();
        const beforeClose = lastTrimmed.slice(0, -closeDelim.length);
        if (beforeClose) mathLines.push(beforeClose);
        i++;
      }
      const mathMlHtml = renderLatexToMathMlHtml(mathLines.join('\n'), true);
      elements.push(
        <div
          key={`math-block-${blockKey++}`}
          style={{
            margin: '12px 0',
            padding: '10px 14px',
            borderRadius: '8px',
            background: 'rgba(15, 23, 42, 0.55)',
            border: '1px solid rgba(167, 139, 250, 0.2)',
            overflowX: 'auto',
            textAlign: 'center',
            color: '#f8fafc',
            fontSize: '1.08rem',
          }}
          dangerouslySetInnerHTML={{ __html: mathMlHtml }}
        />
      );
      continue;
    }

    // 2. Multi-line or single-line raw MathML block (<math ...> ... </math>)
    if (trimmed.startsWith('<math')) {
      const mathMlLines: string[] = [line];
      while (i < lines.length && !lines[i].includes('</math>')) {
        i++;
        if (i < lines.length) {
          mathMlLines.push(lines[i]);
        }
      }
      i++;
      const fullMathMl = mathMlLines.join('\n');
      const isDisplayBlock = fullMathMl.includes('display="block"');
      elements.push(
        <div
          key={`raw-mathml-${blockKey++}`}
          style={{
            margin: '10px 0',
            padding: isDisplayBlock ? '10px 14px' : '4px 0',
            borderRadius: isDisplayBlock ? '8px' : undefined,
            background: isDisplayBlock ? 'rgba(15, 23, 42, 0.55)' : undefined,
            border: isDisplayBlock ? '1px solid rgba(167, 139, 250, 0.2)' : undefined,
            overflowX: 'auto',
            textAlign: isDisplayBlock ? 'center' : 'left',
            color: '#f8fafc',
            fontSize: '1.05rem',
          }}
          dangerouslySetInnerHTML={{ __html: fullMathMl }}
        />
      );
      continue;
    }

    // 3. Fenced code block (```...)
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing ```
      elements.push(
        <pre
          key={`pre-${blockKey++}`}
          style={{
            margin: '10px 0',
            padding: '12px 14px',
            borderRadius: '8px',
            background: 'rgba(9, 14, 26, 0.92)',
            border: '1px solid rgba(148, 163, 184, 0.25)',
            overflowX: 'auto',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: '0.78rem',
            lineHeight: 1.5,
            color: '#e2e8f0',
          }}
        >
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // 4. Horizontal rule (---, ***, ___)
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      elements.push(
        <hr
          key={`hr-${blockKey++}`}
          style={{
            border: 'none',
            borderTop: '1px solid rgba(148, 163, 184, 0.25)',
            margin: '14px 0',
          }}
        />
      );
      i++;
      continue;
    }

    // 5. Headings (# .. ######)
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const fontSizes: Record<number, string> = {
        1: '1.3rem',
        2: '1.12rem',
        3: '0.98rem',
        4: '0.9rem',
        5: '0.85rem',
        6: '0.82rem',
      };
      elements.push(
        <div
          key={`h-${blockKey++}`}
          role="heading"
          aria-level={level}
          style={{
            margin: level <= 2 ? '18px 0 8px 0' : '12px 0 6px 0',
            paddingBottom: level <= 2 ? '5px' : 0,
            borderBottom:
              level <= 2 ? '1px solid rgba(167, 139, 250, 0.25)' : 'none',
            fontSize: fontSizes[level] || '0.9rem',
            fontWeight: 700,
            color: level === 1 ? '#f8fafc' : level === 2 ? '#c4b5fd' : '#e2e8f0',
            letterSpacing: '0.01em',
          }}
        >
          {parseInlineMarkdown(headingText)}
        </div>
      );
      i++;
      continue;
    }

    // 6. Markdown Table
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const headerCells = splitTableRow(lines[i]);
      i += 2; // skip header + separator row
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }

      elements.push(
        <div
          key={`tbl-wrap-${blockKey++}`}
          style={{
            margin: '12px 0',
            overflowX: 'auto',
            borderRadius: '8px',
            border: '1px solid rgba(148, 163, 184, 0.25)',
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.8rem',
              textAlign: 'left',
            }}
          >
            <thead>
              <tr style={{ background: 'rgba(30, 41, 59, 0.9)' }}>
                {headerCells.map((cell, cIdx) => (
                  <th
                    key={`th-${cIdx}`}
                    style={{
                      padding: '8px 11px',
                      borderBottom: '1px solid rgba(167, 139, 250, 0.35)',
                      color: '#e2e8f0',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {parseInlineMarkdown(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rIdx) => (
                <tr
                  key={`tr-${rIdx}`}
                  style={{
                    background:
                      rIdx % 2 === 0
                        ? 'rgba(15, 23, 42, 0.55)'
                        : 'rgba(30, 41, 59, 0.35)',
                  }}
                >
                  {row.map((cell, cIdx) => (
                    <td
                      key={`td-${cIdx}`}
                      style={{
                        padding: '7px 11px',
                        borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
                        color: '#cbd5e1',
                      }}
                    >
                      {parseInlineMarkdown(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 7. Blockquote (> ...)
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      elements.push(
        <blockquote
          key={`bq-${blockKey++}`}
          style={{
            margin: '10px 0',
            padding: '8px 14px',
            borderLeft: '3px solid #a78bfa',
            background: 'rgba(139, 92, 246, 0.1)',
            borderRadius: '0 6px 6px 0',
            color: '#cbd5e1',
            fontSize: '0.84rem',
          }}
        >
          {parseInlineMarkdown(quoteLines.join(' '))}
        </blockquote>
      );
      continue;
    }

    // 8. Unordered List (- / * / +)
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      elements.push(
        <ul
          key={`ul-${blockKey++}`}
          style={{
            margin: '6px 0 10px 0',
            paddingLeft: '20px',
            color: '#cbd5e1',
            fontSize: '0.85rem',
            lineHeight: 1.6,
          }}
        >
          {items.map((item, idx) => (
            <li key={`li-${idx}`} style={{ marginBottom: '4px' }}>
              {parseInlineMarkdown(item)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 9. Ordered List (1. / 2. ...)
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      elements.push(
        <ol
          key={`ol-${blockKey++}`}
          style={{
            margin: '6px 0 10px 0',
            paddingLeft: '22px',
            color: '#cbd5e1',
            fontSize: '0.85rem',
            lineHeight: 1.6,
          }}
        >
          {items.map((item, idx) => (
            <li key={`oli-${idx}`} style={{ marginBottom: '4px' }}>
              {parseInlineMarkdown(item)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // 10. Standard Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('$$') &&
      !lines[i].trim().startsWith('\\[') &&
      !lines[i].trim().startsWith('<math') &&
      !lines[i].trim().startsWith('>') &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !(
        lines[i].trim().includes('|') &&
        i + 1 < lines.length &&
        isTableSeparatorLine(lines[i + 1])
      )
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }

    elements.push(
      <p
        key={`p-${blockKey++}`}
        style={{
          margin: '6px 0 10px 0',
          color: '#cbd5e1',
          fontSize: '0.85rem',
          lineHeight: 1.62,
        }}
      >
        {parseInlineMarkdown(paraLines.join(' '))}
      </p>
    );
  }

  return <div id="ai-assessment-markdown-output">{elements}</div>;
};
