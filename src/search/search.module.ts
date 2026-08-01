import { Module } from "@nestjs/common";
import { CrudCoreModule } from "../crud/crud-core.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

// Imports CrudCoreModule, not CrudModule: pulling in the module that owns
// CrudController would register its /api/:tenant/:resource catch-all here — at
// SearchModule's position — ahead of every workflow route declared after it.
@Module({
  imports: [CrudCoreModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
