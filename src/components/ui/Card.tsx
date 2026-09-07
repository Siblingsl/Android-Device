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
    <div
      className={clsx("card", hover && "hoverable", className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {(title || action) && (
        <div className="card-head">
          {title && <div className="card-title">{title}</div>}
          {action}
        </div>
      )}
      <div className={clsx(padding && "card-body")}>{children}</div>
    </div>
  );
}
