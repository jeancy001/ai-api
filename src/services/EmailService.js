import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { Notification } from "../models/Notification.js";
const escape=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
export class EmailService {
 constructor(){this.transporter=env.SMTP_HOST&&env.SMTP_USER?nodemailer.createTransport({host:env.SMTP_HOST,port:env.SMTP_PORT,secure:env.SMTP_SECURE,auth:{user:env.SMTP_USER,pass:env.SMTP_PASS}}):null}
 async send({userId,to,type,subject,content,dedupeKey}){if(!this.transporter)return {skipped:true};
  if(dedupeKey&&await Notification.exists({dedupeKey,status:"sent"}))return {deduplicated:true};
  const n=await Notification.create({userId,type,subject,dedupeKey});try{await this.transporter.sendMail({from:env.SMTP_FROM,to,subject,html:`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><h2>Trading Platform</h2><div>${content}</div><hr><small>This notification does not contain account credentials.</small></div>`});n.status="sent";n.sentAt=new Date();await n.save();return {sent:true}}catch(e){n.status="failed";n.error=e.message;await n.save();throw e}}
 welcome(args){return this.send({...args,type:"welcome",subject:"Welcome",content:`<p>Welcome, ${escape(args.name)}.</p>`})}
 event(args){return this.send(args)}
}
export const emailService=new EmailService();
