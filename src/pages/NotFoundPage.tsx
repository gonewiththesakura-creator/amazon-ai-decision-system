import { ArrowLeft, Compass } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="not-found">
      <Compass size={34} aria-hidden="true" />
      <span className="eyebrow">404 · ROUTE NOT FOUND</span>
      <h1>这个研究路径不存在</h1>
      <p>页面可能已移动，或对应的市场与项目尚未建立。</p>
      <Link className="button button--primary" to="/"><ArrowLeft size={16} aria-hidden="true" />返回今日简报</Link>
    </div>
  );
}
