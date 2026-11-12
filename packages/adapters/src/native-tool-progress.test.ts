import {expect,it} from 'vitest';
import {nativeToolProgress} from './native-tool-progress.js';
it('uses public stage labels without raw tool protocol text',()=>{
 expect(nativeToolProgress('memory_search','start')).toBe('正在检索记忆…');
 expect(nativeToolProgress('exec','result')).toBe('正在核对工具返回的结果…');
 expect(nativeToolProgress('process','result',true)).toContain('仍在运行');
 expect(nativeToolProgress('untrusted tool name','start')).toBe('正在调用工具…');
 expect(nativeToolProgress('exec','update')).toBeUndefined();
});
