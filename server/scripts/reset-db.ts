import { resetWorkspaceData } from '../database/demo-seed.js';
import { openDatabase } from '../database/database.js';

const database = openDatabase();
resetWorkspaceData(database);
database.close();
console.log('业务数据已清空，系统已恢复为 empty 模式。');
