import mongoose from "mongoose";
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,ref:"User",index:true},
 type:String,status:{type:String,default:"pending"},subject:String,
 dedupeKey:{type:String,index:true},sentAt:Date,error:String
},{timestamps:true});
export const Notification=mongoose.model("Notification",schema);
