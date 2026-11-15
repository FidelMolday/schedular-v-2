declare module "sanitize-html" {
  type Options = {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowedStyles?: Record<string, Record<string, RegExp[]>>;
    allowedSchemes?: string[];
    allowedSchemesByTag?: Record<string, string[]>;
    allowProtocolRelative?: boolean;
    disallowedTagsMode?: "discard" | "completelyEscape" | "escape";
    transformTags?: Record<string, (tagName: string, attribs: Record<string, string>) => { tagName: string; attribs: Record<string, string | undefined> }>;
  };
  export default function sanitizeHtml(input: string, options?: Options): string;
}
