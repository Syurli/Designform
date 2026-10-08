import { writeBytes } from './files.ts';

/** 固定结构的连接时序记录；不写项目内容、名称、磁盘路径、凭证或请求参数。 */
export interface ConnectionTiming {
  at: string;
  route: '/api/session' | '/api/projects' | '/api/connections';
  method: string;
  mode?: 'handshake' | 'library';
  status: number;
  elapsedMs: number;
  errorCode?: string;
  stages: Record<string, number>;
}

/** 最近一百条记录保存在工作区诊断目录，与任何项目及公开版本分离。 */
export function createConnectionDiagnostics(home: string) {
  const records: ConnectionTiming[] = [];
  let writing = false, dirty = false;
  const flush = async () => {
    if (writing) return;
    writing = true;
    try {
      do {
        dirty = false;
        await writeBytes(home, 'diagnostics/connection-timing.json', JSON.stringify({ format: 1, records }, null, 2));
      } while (dirty);
    } catch {
      // 诊断写入失败不能阻断会话，也不把底层路径或异常正文泄露到日志。
      console.error('[cewen-connection] diagnostics-write-failed');
    } finally { writing = false; }
  };
  return (record: ConnectionTiming) => {
    records.push(record); if (records.length > 100) records.shift();
    dirty = true;
    console.error('[cewen-connection] ' + JSON.stringify(record));
    void flush();
  };
}
