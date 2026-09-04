// Idempotent migration: historical Phoenix data remains Phoenix data.
module.exports=function migrateRoute(save){
 const s=Object.assign({},save||{});if(Number(s.routeVersion)>=20)return s;
 const hadFinal=!!s.gameCompleted;
 for(const key of ['completedStages','bestScores','treasures','stageMetrics','visitedStages']){s[key]=Object.assign({},s[key]||{});if(Object.prototype.hasOwnProperty.call(s[key],'19')){s[key][20]=s[key][19];delete s[key][19];}}
 if(hadFinal||s.collectionUnlocked88){for(let id=1;id<=18;id++)s.visitedStages[id]=true;s.visitedStages[20]=true;}
 if(hadFinal){s.legacyCompletedAt=s.gameCompletedAt;s.gameCompleted=false;s.gameCompletedAt=0;}
 if(Number(s.unlocked)>=19||hadFinal)s.unlocked=19;
 s.routeVersion=20;return s;
};
