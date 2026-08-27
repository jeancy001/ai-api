import mongoose from "mongoose";
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,ref:"User",index:true,required:true},
 type:{type:String,index:true,required:true},message:{type:String,required:true},
 metadata:{type:mongoose.Schema.Types.Mixed}
},{timestamps:true});
export const ActivityLog=mongoose.model("ActivityLog",schema);
