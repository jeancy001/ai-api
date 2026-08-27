import mongoose from "mongoose";
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,ref:"User",unique:true,required:true},
 selectedMarket:String,
 autoTradingEnabled:{type:Boolean,default:false},
 realTradingAuthorized:{type:Boolean,default:false},
 emergencyStop:{type:Boolean,default:false},
 stake:{type:Number,min:0.01,default:1},
 maxStake:{type:Number,min:0.01,default:5},
 minimumBalance:{type:Number,min:0,default:0},
 maxDailyLoss:{type:Number,min:0,default:20},
 maxDailyTrades:{type:Number,min:1,default:10},
 maxConsecutiveLosses:{type:Number,min:1,default:3},
 aiConfidenceThreshold:{type:Number,min:0,max:1,default:0.7},
 analysisInterval:{type:Number,min:5000,default:15000},
 cooldown:{type:Number,min:0,default:30000}
},{timestamps:true});
export const TradingSettings=mongoose.model("TradingSettings",schema);
