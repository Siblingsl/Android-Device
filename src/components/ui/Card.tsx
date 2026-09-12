import clsx from "clsx";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
  hover?: boolean;
  onClick?: () => void;
  padding?: boolean;
}

export function Card({
  children,
  className,
  title,
  action,
  hover = false,
  onClick,
  padding = true,
}: Props) {
  return (
    <section
      className={clsx("module", hover && "hoverable", className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {(title || action) && (
        <div className="module-head">
          {title && <div className="module-title">{title}</div>}
          {action}
        </div>
      )}
      <div className={clsx(padding && "module-body")}>{children}</div>
    </section>
  );
}
