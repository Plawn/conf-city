import { forwardRef, type InputHTMLAttributes } from "react";
import { cx } from "./cx";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          "glass-input w-full !rounded-lg !px-2.5 !py-1.5 text-[12px] outline-none placeholder:text-surface-500 focus:border-accent-400/60",
          className,
        )}
        {...rest}
      />
    );
  },
);
