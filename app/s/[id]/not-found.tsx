import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="share">
      <section className="panel share-card">
        <strong>This animation link doesn’t exist</strong>
        <p className="muted">It may have been mistyped or copied only partly. Ask your friend to send it again.</p>
        <Link href="/" className="button-link">
          Make your own animation
        </Link>
      </section>
    </main>
  );
}
