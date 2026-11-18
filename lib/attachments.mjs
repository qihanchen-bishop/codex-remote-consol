import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 4;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });

export class AttachmentStore {
  constructor(directory) { this.directory = resolve(directory); this.images = new Map(); this.paths = new Map(); }
  async init() {
    await mkdir(this.directory, {recursive:true,mode:0o700});
    for (const filename of await readdir(this.directory)) {
      if (!filename.endsWith('.json') || !uuid.test(filename.slice(0,-5))) continue;
      try {
        const image = JSON.parse(await readFile(join(this.directory,filename),'utf8'));
        if (image.id !== filename.slice(0,-5) || ![`${image.id}.png`,`${image.id}.jpg`].includes(image.filename)) continue;
        this.remember(image);
      } catch {}
    }
    return this;
  }
  remember(image) { this.images.set(image.id,image); this.paths.set(join(this.directory,image.filename),image); }
  async create(buffer, name, contentType) {
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw fail(413,'每张图片需在 8MB 以内');
    if (!['image/jpeg','image/png','image/webp'].includes(contentType)) throw fail(415,'请选择 JPG、PNG 或 WebP 图片');
    let output, info, mime;
    try {
      const image = sharp(buffer,{limitInputPixels:40_000_000,failOn:'error'});
      const metadata = await image.metadata();
      if (!['jpeg','png','webp'].includes(metadata.format)) throw new Error('unsupported format');
      const resized = image.rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true});
      mime = metadata.hasAlpha ? 'image/png' : 'image/jpeg';
      const result = await (metadata.hasAlpha ? resized.png() : resized.jpeg({quality:86,mozjpeg:true})).toBuffer({resolveWithObject:true});
      output=result.data; info=result.info;
    } catch { throw fail(400,'无法读取这张图片，请使用有效的 JPG、PNG 或 WebP 文件'); }
    if (output.length > MAX_IMAGE_BYTES) throw fail(413,'处理后的图片超过 8MB，请缩小图片后重试');
    const id=randomUUID(), filename=id+(mime==='image/png'?'.png':'.jpg');
    const image={id,filename,name:String(name || '图片').replace(/[\x00-\x1f\x7f]/g,'').slice(0,160) || '图片',mime,size:output.length,width:info.width,height:info.height,createdAt:Date.now()};
    await writeFile(join(this.directory,filename),output,{mode:0o600,flag:'wx'});
    try { await writeFile(join(this.directory,id+'.json'),JSON.stringify(image),{mode:0o600,flag:'wx'}); }
    catch(error) { await rm(join(this.directory,filename),{force:true}); throw error; }
    this.remember(image); return this.publicInfo(image);
  }
  publicInfo(image) { const {id,name,mime,size,width,height}=image;return {id,name,mime,size,width,height}; }
  get(id) { if (!uuid.test(id || '') || !this.images.has(id)) throw fail(404,'图片不存在');return this.images.get(id); }
  inputs(ids = []) {
    if (!Array.isArray(ids) || ids.length>MAX_IMAGES || new Set(ids).size!==ids.length) throw fail(400,'每条消息最多添加 4 张不同的图片');
    return ids.map(id=>{const image=this.get(id);return {type:'localImage',path:join(this.directory,image.filename)};});
  }
  decorate(history) {
    return {...history,data:history.data.map(turn=>({...turn,items:(turn.items || []).map(item=>item.type==='userMessage'?{...item,content:(item.content || []).map(content=>{
      const image=content.type==='localImage' && typeof content.path==='string' ? this.paths.get(resolve(content.path)) : null;
      return image ? {...content,webAttachment:this.publicInfo(image)} : content;
    })}:item)}))};
  }
}
