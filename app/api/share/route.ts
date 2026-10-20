import { ShareSpec, saveShare } from '@/lib/shares';

/** Saves an animation recipe and returns its public link. */
export async function POST(req: Request) {
  const parsed = ShareSpec.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'This animation can’t be shared: ' + parsed.error.issues[0]?.message }, { status: 400 });
  }
  try {
    const id = await saveShare(parsed.data);
    return Response.json({ id, url: new URL(`/s/${id}`, req.url).toString() });
  } catch (err) {
    console.error('Share failed:', err);
    return Response.json({ error: 'Saving the share link failed. Try again in a moment.' }, { status: 500 });
  }
}
