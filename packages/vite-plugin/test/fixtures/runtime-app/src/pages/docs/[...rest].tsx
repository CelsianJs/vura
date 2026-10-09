export const page = { mode: 'server' };
export default function Docs({ params }: { params: Record<string, string> }) { return <p>docs-rest:{params.rest}</p>; }
