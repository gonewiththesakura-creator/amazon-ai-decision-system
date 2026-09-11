import { useEffect, useState } from 'react';
import { PackageOpen } from 'lucide-react';
import clsx from 'clsx';

interface ProductImageProps {
  src?: string | null;
  alt: string;
  size?: 'sm' | 'md' | 'lg';
}

export function ProductImage({ src, alt, size = 'md' }: ProductImageProps) {
  const [failed, setFailed] = useState(!src);

  useEffect(() => setFailed(!src), [src]);

  return (
    <span className={clsx('product-image', `product-image--${size}`, failed && 'is-fallback')}>
      {!failed && src ? (
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <PackageOpen size={size === 'lg' ? 30 : size === 'md' ? 22 : 17} aria-hidden="true" />
      )}
    </span>
  );
}
