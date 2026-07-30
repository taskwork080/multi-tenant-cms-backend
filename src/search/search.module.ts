import { Module } from "@nestjs/common";
import { CrudModule } from "../crud/crud.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

@Module({
  imports: [CrudModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
