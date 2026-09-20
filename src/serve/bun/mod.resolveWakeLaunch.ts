/** Pure legacy shell-line rendering, not argv parsing or execution.
 * Config commands are trusted shell programs; callers must preserve that boundary.
 */
export function resolveWakeLaunch(config: Record<string,unknown>, window: string, explicitEngine?: string, fallback = 'codex'): {selectedKey:string;line:string;family?:string;warnings:string[]} {
  const object=(value:unknown): value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
  const commands=object(config.commands)?config.commands:{};
  const wake=object(config.wake)?config.wake:{};
  const trim=(value:string)=>value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'');
  const text=(value:unknown)=>typeof value==='string' && trim(value)?trim(value):undefined;
  const command=(key:string)=>Object.hasOwn(commands,key)?text(commands[key]):undefined;
  const keys=Object.keys(commands).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const asciiLower=(value:string)=>value.replace(/[A-Z]/g,c=>c.toLowerCase());
  const entry=(candidate:string): [string,string]|undefined=>{
    const exact=command(candidate);if(exact!==undefined)return [candidate,exact];
    for(const key of keys){if(asciiLower(key)===asciiLower(candidate)){const value=command(key);if(value!==undefined)return [key,value];}}
  };
  let resolved: [string,string]|undefined;
  if(explicitEngine!==undefined){const value=command(explicitEngine);if(value!==undefined)resolved=[explicitEngine,value];}
  if(!resolved){const value=command(window);if(value!==undefined)resolved=[window,value];}
  if(!resolved){
    let stem=trim(window);if(stem.length>7 && asciiLower(stem.slice(-7))==='-oracle')stem=trim(stem.slice(0,-7));
    stem=stem.toLowerCase();
    if(stem)for(const candidate of [stem+'-oracle',stem]){if(candidate!==window){resolved=entry(candidate);if(resolved)break;}}
  }
  if(!resolved)for(const key of keys){
    if(key==='default'||key===window)continue;
    if(key.startsWith('*')&&window.endsWith(key.slice(1)) || key.endsWith('*')&&window.startsWith(key.slice(0,-1))){const value=command(key);if(value!==undefined){resolved=[key,value];break;}}
  }
  if(!resolved && explicitEngine!==undefined)resolved=[explicitEngine,explicitEngine];
  if(!resolved){const engine=text(wake.engine)??text(config.defaultEngine);if(engine!==undefined)resolved=[engine,command(engine)??engine];}
  if(!resolved){const value=command('default');if(value!==undefined)resolved=['default',value];}
  resolved??=[fallback,command(fallback)??fallback];
  const [selectedKey,selected]=resolved;
  const quote=(value:string)=>/^[a-zA-Z0-9/._:=\-]*$/.test(value)?value:"'"+value.replace(/'/g,"'\\''")+"'";
  const prefixPool=(line:string)=>typeof config.zaiPool==='string' && /^[a-zA-Z0-9_-]+$/.test(config.zaiPool) && !line.startsWith('MAW_ZAI_POOL=') ? `MAW_ZAI_POOL=${config.zaiPool} ${line}` : line;
  // Preserve the source's whitespace-token heuristic. Quotes/wrappers are not parsed.
  const binary=(line:string): {family:string;end:number}|undefined=>{
    for(const match of line.matchAll(/\P{White_Space}+/gu)){
      const word=match[0];if(word==='command'||/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word))continue;
      return {family:word.split('/').at(-1)!,end:match.index!+word.length};
    }
  };
  const warnings:string[]=[];
  let line=prefixPool(selected);
  const resume=wake.resume===true;
  if(resume){
    const replacement=command(selectedKey+'-resume');
    if(replacement!==undefined)line=prefixPool(replacement);
    else {
      const token=binary(line);
      if(token?.family==='claude')line+=' --continue';
      else if(token?.family==='codex'||token?.family==='omx')line=line.slice(0,token.end)+' resume'+line.slice(token.end);
      else {line+=' resume';warnings.push('unknown_resume_form');}
    }
  }
  if(wake.channels===true){
    const replacement=!resume?command(selectedKey+'-channels'):undefined;
    if(replacement!==undefined)line=prefixPool(replacement);
    else if(binary(line)?.family==='claude')line+=' --channels plugin:discord@claude-plugins-official';
    else warnings.push('channels_not_claude');
  }
  const prompt=text(wake.prompt);
  if(prompt!==undefined){
    const words=trim(line).split(/\p{White_Space}+/u);
    if(binary(line)?.family==='claude' && words.some(word=>word==='--channels'||word.startsWith('--channels=')) && words.at(-1)!=='--')line+=' --';
    line+=' '+quote(prompt);
  }
  const family=binary(line)?.family;
  line=`MAW_SESSION_WINDOW=${quote(window)} ${line}`;
  if(line.includes('\0')||Buffer.byteLength(line)>64*1024)throw new Error('wake launch unavailable');
  return {selectedKey,line,...(family!==undefined?{family}:{}),warnings};
}
