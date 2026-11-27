import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const allowedElements = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li',
  'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'ul',
];

const components: Components = {
  a: ({ href, children }) => {
    if (!href) return <span>{children}</span>;
    if (href.startsWith('#')) return <a href={href}>{children}</a>;
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  table: ({ children }) => <div className="reply-table-scroll"><table>{children}</table></div>,
};

function httpsUrl(value: string) {
  if (!/^https:\/\//i.test(value) || /[\s\\]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url;
  } catch { /* An invalid link stays as readable text. */ }
}

export function ReplyMarkdown({ answer, anchors }: { answer: string; anchors: ReadonlySet<string> }) {
  return <div className="assistant-markdown">
    <Markdown skipHtml allowedElements={allowedElements} components={components} remarkPlugins={[remarkGfm]}
      urlTransform={(value, key) => {
        if (key !== 'href') return;
        if (anchors.has(value)) return value;
        const url = httpsUrl(value);
        if (url?.origin !== window.location.origin) return url?.href;
        if (url.pathname === window.location.pathname && url.search === window.location.search && anchors.has(url.hash)) return url.hash;
      }}>{answer}</Markdown>
  </div>;
}
