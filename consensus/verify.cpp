// Thin process boundary around Bitcoin Core's unmodified consensus interpreter.
#include <bitcoinconsensus.h>
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>
#include <cstdint>
static std::vector<unsigned char> unhex(const std::string& s) {
  if(s.size()%2 || s.size()>150000) throw std::runtime_error("hex");
  std::vector<unsigned char> out;
  auto digit=[](char c)->int {if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;throw std::runtime_error("hex");};
  for(size_t i=0;i<s.size();i+=2)out.push_back(digit(s[i])*16+digit(s[i+1]));
  return out;
}
int main() {
  try {
    if(bitcoinconsensus_version()!=2)throw std::runtime_error("API");
    std::string line; if(!std::getline(std::cin,line))return 2;
    auto tx=unhex(line); if(tx.empty())return 2;
    if(!std::getline(std::cin,line) || line!="2")return 2; // exact two-input QSB withdrawal
    std::vector<std::vector<unsigned char>> scripts;
    std::vector<int64_t> amounts;
    for(int i=0;i<2;i++) {
      if(!std::getline(std::cin,line)||line.empty()||line.find_first_not_of("0123456789")!=std::string::npos)return 2;
      auto amount=std::stoll(line);if(amount<0||amount>2100000000000000LL)return 2;amounts.push_back(amount);
      if(!std::getline(std::cin,line))return 2;scripts.push_back(unhex(line));
    }
    if(std::getline(std::cin,line))return 2;
    UTXO outputs[2];for(int i=0;i<2;i++)outputs[i]={scripts[i].data(),(unsigned int)scripts[i].size(),amounts[i]};
    for(unsigned int i=0;i<2;i++) {
      bitcoinconsensus_error error=bitcoinconsensus_ERR_TX_DESERIALIZE;
      int valid=bitcoinconsensus_verify_script_with_spent_outputs(outputs[i].scriptPubKey,outputs[i].scriptPubKeySize,outputs[i].value,tx.data(),tx.size(),outputs,2,i,bitcoinconsensus_SCRIPT_FLAGS_VERIFY_ALL,&error);
      if(valid!=1||error!=bitcoinconsensus_ERR_OK)return 1;
    }
    std::cout<<"core-27.2-api2-all-inputs-valid\n";return 0;
  } catch(...) {return 2;}
}
