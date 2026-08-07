import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";

export function CommandBar({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-center gap-2 border-t bg-background p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSubmit(value.trim());
        setValue("");
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Describe how you want to work…"
        className="h-10 flex-1"
        autoFocus
      />
      <Button type="submit" className="h-10">Send</Button>
    </form>
  );
}
