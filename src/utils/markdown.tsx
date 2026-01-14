import type { HTMLAttributes, ReactNode } from 'react';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkSoftBreaks = () => (tree: any) => {
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (Array.isArray(node.children)) {
      const nextChildren: any[] = [];
      node.children.forEach((child: any) => {
        if (child?.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
          const parts = child.value.split('\n');
          parts.forEach((part: string, idx: number) => {
            if (part) {
              nextChildren.push({ type: 'text', value: part });
            }
            if (idx < parts.length - 1) {
              nextChildren.push({ type: 'break' });
            }
          });
          return;
        }
        nextChildren.push(child);
      });
      node.children = nextChildren;
      node.children.forEach(visit);
    }
  };
  visit(tree);
};

export const markdownPlugins = [remarkGfm, remarkSoftBreaks];

export const markdownComponents: Components = {
  p: ({ node: _node, children, ...props }) => (
    <p style={{ margin: '0 0 8px', lineHeight: 1.55 }} {...props}>
      {children}
    </p>
  ),
  ul: ({ node: _node, children, ...props }) => (
    <ul style={{ margin: '0 0 8px 18px', padding: 0 }} {...props}>
      {children}
    </ul>
  ),
  ol: ({ node: _node, children, ...props }) => (
    <ol style={{ margin: '0 0 8px 18px', padding: 0 }} {...props}>
      {children}
    </ol>
  ),
  li: ({ node: _node, children, ...props }) => (
    <li style={{ margin: '0 0 4px' }} {...props}>
      {children}
    </li>
  ),
  a: ({ node: _node, children, ...props }) => (
    <a
      {...props}
      style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ node: _node, children, ...props }) => (
    <blockquote
      {...props}
      style={{
        margin: '0 0 8px',
        padding: '6px 10px',
        borderLeft: '3px solid rgba(94,129,172,0.6)',
        color: 'var(--text-secondary)',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 8,
      }}
    >
      {children}
    </blockquote>
  ),
  code: ({
    node: _node,
    inline,
    children,
    ...props
  }: {
    node?: unknown;
    inline?: boolean;
    children?: ReactNode;
  } & HTMLAttributes<HTMLElement>) => (
    <code
      {...props}
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 12,
        padding: inline ? '1px 4px' : '8px 10px',
        borderRadius: 8,
        background: 'rgba(15, 20, 28, 0.7)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: inline ? 'inline' : 'block',
        whiteSpace: 'pre-wrap',
      }}
    >
      {children}
    </code>
  ),
  pre: ({ node: _node, children, ...props }) => (
    <pre
      {...props}
      style={{
        margin: '0 0 8px',
        whiteSpace: 'pre-wrap',
        overflowX: 'auto',
      }}
    >
      {children}
    </pre>
  ),
  table: ({ node: _node, children, ...props }) => (
    <table
      {...props}
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        margin: '0 0 8px',
        fontSize: 12,
      }}
    >
      {children}
    </table>
  ),
  th: ({ node: _node, children, ...props }) => (
    <th
      {...props}
      style={{
        textAlign: 'left',
        borderBottom: '1px solid var(--border-strong)',
        padding: '6px 8px',
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  ),
  td: ({ node: _node, children, ...props }) => (
    <td
      {...props}
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        padding: '6px 8px',
        verticalAlign: 'top',
      }}
    >
      {children}
    </td>
  ),
  hr: ({ node: _node, ...props }) => (
    <hr
      {...props}
      style={{
        border: 'none',
        borderTop: '1px solid var(--border-subtle)',
        margin: '10px 0',
      }}
    />
  ),
  img: ({ node: _node, ...props }) => (
    <img
      {...props}
      style={{ maxWidth: '100%', height: 'auto', borderRadius: 8 }}
      alt={props.alt ?? ''}
    />
  ),
};
