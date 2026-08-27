import mongoose from "mongoose";
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,ref:"User",index:true,required:true},
 derivAccountId:{type:String,index:true,required:true},
 derivContractId:{type:String,index:true},
 symbol:{type:String,index:true,required:true},
 contractType:String,stake:Number,buyPrice:Number,
 status:{type:String,default:"pending",index:true},
 profitLoss:Number,openedAt:Date,closedAt:Date,
 aiAnalysis:{action:String,confidence:Number,reason:String},
 riskDecision:{approved:Boolean,reasons:[String]}
},{timestamps:true});
export const Trade=mongoose.model("Trade",schema);
