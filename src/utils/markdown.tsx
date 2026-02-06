import type { HTMLAttributes, ReactNode } from 'react';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const markdownPlugins = [remarkGfm];

export const markdownComponents: Components = {
  h1: ({ node: _node, children, ...props }) => (
    <h1 style={{ margin: '0 0 0.7em', lineHeight: 1.25, fontSize: '1.75em', fontWeight: 700 }} {...props}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, children, ...props }) => (
    <h2 style={{ margin: '0 0 0.65em', lineHeight: 1.3, fontSize: '1.45em', fontWeight: 700 }} {...props}>
      {children}
    </h2>
  ),
  h3: ({ node: _node, children, ...props }) => (
    <h3 style={{ margin: '0 0 0.6em', lineHeight: 1.35, fontSize: '1.22em', fontWeight: 700 }} {...props}>
      {children}
    </h3>
  ),
  h4: ({ node: _node, children, ...props }) => (
    <h4 style={{ margin: '0 0 0.55em', lineHeight: 1.4, fontSize: '1.1em', fontWeight: 600 }} {...props}>
      {children}
    </h4>
  ),
  h5: ({ node: _node, children, ...props }) => (
    <h5 style={{ margin: '0 0 0.5em', lineHeight: 1.4, fontSize: '1em', fontWeight: 600 }} {...props}>
      {children}
    </h5>
  ),
  h6: ({ node: _node, children, ...props }) => (
    <h6 style={{ margin: '0 0 0.5em', lineHeight: 1.4, fontSize: '0.92em', fontWeight: 600, color: 'var(--text-secondary)' }} {...props}>
      {children}
    </h6>
  ),
  p: ({ node: _node, children, ...props }) => (
    <p style={{ margin: '0 0 0.7em', lineHeight: 1.55 }} {...props}>
      {children}
    </p>
  ),
  ul: ({ node: _node, children, ...props }) => (
    <ul style={{ margin: '0 0 0.7em', paddingLeft: '1.5em' }} {...props}>
      {children}
    </ul>
  ),
  ol: ({ node: _node, children, ...props }) => (
    <ol style={{ margin: '0 0 0.7em', paddingLeft: '1.5em' }} {...props}>
      {children}
    </ol>
  ),
  li: ({ node: _node, children, ...props }) => (
    <li style={{ margin: '0.2em 0', lineHeight: 1.5 }} {...props}>
      {children}
    </li>
  ),
  a: ({ node: _node, children, ...props }) => (
    <a
      {...props}
      style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}
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
        margin: '0 0 0.8em',
        padding: '0.2em 0.9em',
        borderLeft: '0.25em solid rgba(255,255,255,0.25)',
        color: 'var(--text-secondary)',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 6,
      }}
    >
      {children}
    </blockquote>
  ),
  code: ({
    node: _node,
    className,
    children,
    ...props
  }: {
    node?: unknown;
    className?: string;
    children?: ReactNode;
  } & HTMLAttributes<HTMLElement>) => (
    (() => {
      const text = String(children ?? '');
      const isBlock = (className?.includes('language-') ?? false) || text.includes('\n');
      if (isBlock) {
        return (
          <code
            {...props}
            className={className}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: '0.9em',
            }}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          {...props}
          className={className}
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: '0.9em',
            padding: '0.15em 0.4em',
            borderRadius: 6,
            background: 'rgba(175, 184, 193, 0.2)',
            border: '1px solid rgba(255,255,255,0.08)',
            display: 'inline',
            whiteSpace: 'break-spaces',
            overflowWrap: 'normal',
            wordBreak: 'normal',
          }}
        >
          {children}
        </code>
      );
    })()
  ),
  pre: ({ node: _node, children, ...props }) => (
    <pre
      {...props}
      style={{
        margin: '0 0 0.8em',
        padding: '0.8em 1em',
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(15, 20, 28, 0.72)',
        lineHeight: 1.45,
        whiteSpace: 'pre',
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
        margin: '0 0 0.8em',
        fontSize: '0.92em',
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
        borderBottom: '1px solid rgba(255,255,255,0.2)',
        padding: '0.45em 0.6em',
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
        borderBottom: '1px solid rgba(255,255,255,0.12)',
        padding: '0.45em 0.6em',
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
        borderTop: '1px solid rgba(255,255,255,0.16)',
        margin: '0.9em 0',
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
