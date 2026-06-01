export interface PanelLine {
  text: string;
}

export function placeholderPanelLine(text: string): PanelLine {
  return { text };
}
