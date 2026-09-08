import { useRef } from "react";
import { Button } from "../ui";

export function DataPanel({
  onFile,
  canReset,
  onReset,
}: {
  onFile: (file: File) => void;
  canReset: boolean;
  onReset: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="heading mb-2">Data</div>
      <Button className="w-full" onClick={() => fileInputRef.current?.click()}>
        Load JSON…
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            onFile(file);
          }
          e.target.value = "";
        }}
      />
      <div className="mt-1 text-center text-[10px] text-surface-500">or drop a file anywhere</div>
      {canReset && (
        <button
          type="button"
          onClick={onReset}
          className="mt-1 cursor-pointer text-[11px] text-surface-400 underline hover:text-white"
        >
          Reset to sample
        </button>
      )}
    </div>
  );
}
