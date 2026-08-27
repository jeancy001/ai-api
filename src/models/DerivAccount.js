import mongoose from "mongoose";
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,ref:"User",index:true,required:true},
 derivAccountId:{type:String,required:true,index:true},
 accountType:{type:String,enum:["real","demo"],required:true},
 currency:String,status:String,group:String,
 encryptedAccessToken:{type:String,select:false},
 tokenExpiresAt:Date,
 connectionStatus:{type:String,enum:["connected","disconnected","error"],default:"disconnected"},
 lastKnownBalance:Number,lastBalanceUpdatedAt:Date,
 selected:{type:Boolean,default:false}
},{timestamps:true});
schema.index({userId:1,derivAccountId:1},{unique:true});
schema.set("toJSON",{transform:(d,r)=>{delete r.encryptedAccessToken;return r}});
export const DerivAccount=mongoose.model("DerivAccount",schema);
