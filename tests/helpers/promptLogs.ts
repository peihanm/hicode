import {readdir} from "node:fs/promises";
import {join} from "node:path";
export async function listPromptLogs(directory:string):Promise<string[]> {
    const result:string[]=[];
    const walk=async(relative:string)=>{
        for(const entry of await readdir(join(directory,relative),{withFileTypes:true})){
            const path=join(relative,entry.name);
            if(entry.isDirectory())await walk(path);
            else if(entry.isFile()&&/^\d{4}-.*_[a-f0-9-]+\.json$/.test(entry.name))result.push(path);
        }
    };
    await walk("");
    return result.sort((a,b)=>a.split("/").at(-1)!.localeCompare(b.split("/").at(-1)!));
}
