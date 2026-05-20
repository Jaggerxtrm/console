declare module "xterm" {
  export class Terminal {
    cols: number;
    rows: number;
    constructor(options?: Record<string, unknown>);
    loadAddon(addon: unknown): void;
    open(element: HTMLElement): void;
    onData(handler: (data: string) => void): void;
    write(data: string | Uint8Array): void;
    dispose(): void;
  }
}

declare module "@xterm/addon-fit" {
  export class FitAddon {
    fit(): void;
    dispose(): void;
  }
}
