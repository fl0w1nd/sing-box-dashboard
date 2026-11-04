import { createContext, useContext, type ReactNode } from "react";

import { Icon } from "./Icon";

// The eyebrow above each page title reads "<server> / <section>"; the shell
// provides the server name and the section of the current route.
export interface PageHeaderContextValue {
  server: string;
  section: string | null;
}

export const PageHeaderContext = createContext<PageHeaderContextValue>({ server: "", section: null });

export function PageHeader(props: {
  title: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
  crumbs?: string[];
}) {
  const context = useContext(PageHeaderContext);
  const crumbs =
    props.crumbs ??
    (context.section !== null
      ? [context.section]
      : typeof props.title === "string"
        ? [props.title]
        : []);
  const eyebrow = [context.server, ...crumbs].filter((crumb) => crumb !== "");

  return (
    <div className="page-header">
      {props.back !== undefined && (
        <button type="button" className="back-button" aria-label={props.back.label} onClick={props.back.onClick}>
          <Icon name="arrow_back" size={20} />
        </button>
      )}
      <div className="page-heading">
        {eyebrow.length > 0 && (
          <div className="page-eyebrow">
            {eyebrow.map((crumb, index) => (
              <span key={index}>{crumb}</span>
            ))}
          </div>
        )}
        <h1 className="page-title">{props.title}</h1>
      </div>
      {props.actions !== undefined && <div className="actions">{props.actions}</div>}
    </div>
  );
}
