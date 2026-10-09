export const page = { mode: 'server' };
export default function Report({ params }: { params: Record<string, string> }) { return <p>report-slug:{params.slug}</p>; }
