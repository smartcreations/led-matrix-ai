import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SharedPlayer from '@/components/SharedPlayer';
import { loadShare } from '@/lib/shares';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const share = await loadShare((await params).id);
  if (!share) return { title: 'Animation not found · LED Matrix Studio' };
  return {
    title: `${share.title} · LED Matrix Studio`,
    description: `A ${share.width}×${share.height} LED matrix animation made with LED Matrix Studio.`,
  };
}

export default async function SharePage({ params }: Props) {
  const share = await loadShare((await params).id);
  if (!share) notFound();
  return <SharedPlayer share={share} />;
}
