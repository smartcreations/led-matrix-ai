import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LED Matrix Studio',
  description: 'Describe an animation and preview it on an LED matrix',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
