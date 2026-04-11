/** Allow importing .css files as text strings (esbuild loader: { ".css": "text" }). */
declare module "*.css" {
  const content: string;
  export default content;
}
