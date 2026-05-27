import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, X } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export function BulkStep1() {
  const navigate = useNavigate();
  const [sourceHost, setSourceHost] = useState('');
  const [targetHost, setTargetHost] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setError('File must be .csv or .txt');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ''));
      setFileName(file.name);
      setError(null);
    };
    reader.onerror = () => setError('Failed to read file');
    reader.readAsText(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const clearFile = () => {
    setCsv('');
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const previewPairs = (() => {
    try {
      const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
      return lines.map((l, i) => {
        const [su, sp, tu, tp] = l.split(',').map((s) => s.trim());
        return { i, valid: !!(su && sp && tu && tp), su, tu };
      });
    } catch {
      return [];
    }
  })();
  const validCount = previewPairs.filter((p) => p.valid).length;

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      if (!sourceHost || !targetHost) throw new Error('Source and target server are required');
      const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
      const pairs = lines.map((l) => {
        const [su, sp, tu, tp] = l.split(',').map((s) => s.trim());
        if (!su || !sp || !tu || !tp) throw new Error(`Invalid line: ${l}`);
        return { sourceUsername: su, sourcePassword: sp, targetUsername: tu, targetPassword: tp };
      });
      if (!pairs.length) throw new Error('No pairs found');
      await api.createBulk({
        sourceHost,
        sourcePort: 993,
        sourceSecurity: 'SSL/TLS',
        targetHost,
        targetPort: 993,
        targetSecurity: 'SSL/TLS',
        pairs,
      });
      navigate('/');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <h2 className="text-primary-dark font-extrabold text-2xl">Bulk Migration</h2>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200/80 rounded-xl p-3">
          <label className="block text-slate-400 font-extrabold text-[10px] uppercase tracking-wider mb-1">
            Source Server (IMAP)
          </label>
          <input
            value={sourceHost}
            onChange={(e) => setSourceHost(e.target.value)}
            placeholder="imap.source.com"
            className="w-full bg-transparent text-primary font-bold text-[15px] outline-none"
          />
        </div>
        <div className="bg-white border border-slate-200/80 rounded-xl p-3">
          <label className="block text-slate-400 font-extrabold text-[10px] uppercase tracking-wider mb-1">
            Target Server (IMAP)
          </label>
          <input
            value={targetHost}
            onChange={(e) => setTargetHost(e.target.value)}
            placeholder="imap.target.com"
            className="w-full bg-transparent text-primary font-bold text-[15px] outline-none"
          />
        </div>
      </div>

      <div>
        <h3 className="text-primary-dark font-extrabold text-lg mb-3">Mailbox Pairs</h3>
        <p className="text-sm text-slate-500 mb-3">
          Format per line:{' '}
          <code className="bg-slate-100 px-2 py-0.5 rounded text-primary">
            source_user,source_password,target_user,target_password
          </code>
        </p>

        {/* Drag & drop zone */}
        <div
          id="drag-drop-zone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all',
            dragOver
              ? 'border-primary bg-primary/5'
              : 'border-slate-300 bg-slate-50/30 hover:bg-primary/5 hover:border-primary/40',
          )}
        >
          {fileName ? (
            <div className="flex items-center justify-center gap-3">
              <div className="bg-primary/5 rounded-full p-3">
                <FileText className="h-6 w-6 text-primary" />
              </div>
              <div className="text-left">
                <div className="text-primary font-bold text-sm">{fileName}</div>
                <div className="text-slate-500 text-xs">
                  {validCount} valid pair{validCount === 1 ? '' : 's'} detected
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  clearFile();
                }}
                className="bg-slate-100 hover:bg-slate-200 rounded-full p-1.5 ml-2"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="bg-primary/5 rounded-full p-3">
                <Upload className="h-6 w-6 text-primary" />
              </div>
              <div>
                <div className="text-primary font-bold text-sm">Drop CSV file here</div>
                <div className="text-slate-500 text-xs mt-1">or click to browse (.csv or .txt)</div>
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
            }}
          />
        </div>

        <details className="mt-4">
          <summary className="text-sm font-bold text-primary cursor-pointer hover:text-primary-dark">
            Or paste / edit CSV manually
          </summary>
          <textarea
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setFileName(null);
            }}
            rows={8}
            placeholder="user1@src.com,pwd1,user1@tgt.com,pwd1
user2@src.com,pwd2,user2@tgt.com,pwd2"
            className="w-full mt-3 bg-white border border-slate-200/80 rounded-xl p-3 text-primary text-[13px] font-mono outline-none focus:border-primary/50"
          />
        </details>

        {/* Preview */}
        {previewPairs.length > 0 && (
          <div className="mt-4 border border-slate-100 rounded-xl overflow-hidden">
            <div className="bg-slate-50 px-4 py-2 flex items-center justify-between text-xs font-bold">
              <span className="text-primary-dark">
                Preview ({previewPairs.length} line{previewPairs.length === 1 ? '' : 's'})
              </span>
              <span className="text-emerald-600">{validCount} valid</span>
            </div>
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {previewPairs.slice(0, 50).map((p) => (
                    <tr key={p.i} className={cn(!p.valid && 'bg-red-50')}>
                      <td className="py-1.5 px-3 text-slate-400 w-8">{p.i + 1}</td>
                      <td className="py-1.5 px-3 text-primary font-semibold">
                        {p.su || <em className="text-red-500">missing</em>}
                      </td>
                      <td className="py-1.5 px-3 text-slate-400">→</td>
                      <td className="py-1.5 px-3 text-primary font-semibold">
                        {p.tu || <em className="text-red-500">missing</em>}
                      </td>
                    </tr>
                  ))}
                  {previewPairs.length > 50 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-2 px-3 text-center text-slate-400 italic text-xs"
                      >
                        … {previewPairs.length - 50} more rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {error && <div className="bg-[#D32F2F] text-white rounded-xl p-4 text-sm">{error}</div>}

      <button
        onClick={submit}
        disabled={submitting || validCount === 0}
        className="w-full bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 font-bold text-[15px] shadow-md disabled:opacity-60"
      >
        {submitting
          ? 'Starting…'
          : `Start Bulk Migration (${validCount} pair${validCount === 1 ? '' : 's'})`}
      </button>
    </div>
  );
}
