import mongoose from "mongoose";
import bcrypt from "bcryptjs";
const schema=new mongoose.Schema({
  name:{type:String,trim:true,minlength:2,maxlength:100,required:true},
  email:{type:String,trim:true,lowercase:true,unique:true,index:true,required:true},
  passwordHash:{type:String,required:true,select:false},
  status:{type:String,enum:["active","disabled"],default:"active"}
},{timestamps:true});
schema.methods.comparePassword=function(password){return bcrypt.compare(password,this.passwordHash)};
schema.set("toJSON",{transform:(d,r)=>{delete r.passwordHash;return r}});
export const User=mongoose.model("User",schema);
